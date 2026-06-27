#!/usr/bin/env node
// verify-snapshot-manifest.mjs — FR-FORGE-001/003: Verify content-binding hash manifest
//
// Usage (module):
//   import { verifyManifest } from "./verify-snapshot-manifest.mjs";
//   const result = verifyManifest({ verdictFile });
//
// Usage (CLI):
//   node verify-snapshot-manifest.mjs --verdict=<path>
//
// Returns:
//   { file_status: "ok"|"drift"|"no-manifest",
//     verdict_status: "ok"|"drift"|"no-manifest",
//     drifted_files: string[],
//     verdict_drift: boolean }
//
// Never throws. Never produces non-zero exit code for drift.
// Exit code 0 always — drift is informational, not blocking.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Check whether absPath ends with relativePath on segment boundaries.
 * e.g. "/a/b/abc/verdict.json" endsWith "bc/verdict.json" via String.endsWith
 * BUT the segment boundary is at "/abc/" not "/bc/" — this rejects that false match.
 * Also rejects leading ".." in relativePath and absolute relativePath.
 */
function isSegmentAnchored(absPath, relativePath) {
  // Must be a relative descendant (no leading .., not absolute)
  if (relativePath.startsWith(".." + sep) || relativePath.startsWith("/")) return false;
  if (relativePath === "..") return false;

  // Segment-wise suffix check: split both into path segments.
  // The last N segments of absPath must exactly match all segments of relativePath.
  const absSegs = absPath.split(sep);
  const relSegs = relativePath.split(sep);
  if (absSegs.length < relSegs.length) return false;
  for (let i = 0; i < relSegs.length; i++) {
    if (absSegs[absSegs.length - relSegs.length + i] !== relSegs[i]) return false;
  }
  return true;
}

/**
 * Validate that a stored manifest path is a clean relative descendant
 * (no leading "..", no internal ".." segments, not absolute).
 */
function isCleanDescendant(p) {
  if (!p || typeof p !== "string") return false;
  if (p.startsWith("/")) return false;
  if (p.startsWith(".." + sep) || p === "..") return false;
  // R3: Reject ANY path that contains a ".." segment (not just leading).
  // join(repoRoot, "safe/../../evil") normalizes traversal above repoRoot.
  // Manifest paths are always stored with "/" separators.
  if (p.split("/").some(seg => seg === "..")) return false;
  return true;
}

/**
 * Validate manifest object shape before any hash comparison.
 * Returns true only when the manifest has the required frozen shape:
 *   - manifest_version === "1"
 *   - hash_algorithm === "sha256"
 *   - verdict_binding is object with verdict_file (string) and hash (sha256 hex)
 *   - files is array of {path: string, hash: sha256 hex}
 * Otherwise returns false. Never throws.
 */
function isValidManifestShape(m) {
  // Must be a non-null object
  if (!m || typeof m !== "object") return false;

  // Required top-level fields with exact values
  if (m.manifest_version !== "1") return false;
  if (m.hash_algorithm !== "sha256") return false;

  // verdict_binding must be an object with required fields
  if (!m.verdict_binding || typeof m.verdict_binding !== "object") return false;
  if (typeof m.verdict_binding.verdict_file !== "string" || m.verdict_binding.verdict_file.length === 0) return false;
  if (typeof m.verdict_binding.hash !== "string" || !SHA256_HEX.test(m.verdict_binding.hash)) return false;

  // files must be an array (empty is valid)
  if (!Array.isArray(m.files)) return false;
  // Each file entry must be { path: string, hash: sha256 hex }
  for (const f of m.files) {
    if (!f || typeof f !== "object") return false;
    if (typeof f.path !== "string" || f.path.length === 0) return false;
    if (typeof f.hash !== "string" || !SHA256_HEX.test(f.hash)) return false;
  }

  return true;
}

/**
 * Verify the manifest sidecar for a verdict file.
 *
 * @param {{ verdictFile: string }} params
 * @returns {{
 *   file_status: "ok"|"drift"|"no-manifest",
 *   verdict_status: "ok"|"drift"|"no-manifest",
 *   drifted_files: string[],
 *   verdict_drift: boolean
 * }}
 */
export function verifyManifest({ verdictFile }) {
  const manifestPath = verdictFile + ".snapshot-manifest";

  // No manifest — not an error, just no binding exists
  if (!existsSync(manifestPath)) {
    return {
      file_status: "no-manifest",
      verdict_status: "no-manifest",
      drifted_files: [],
      verdict_drift: false,
    };
  }

  let manifest;
  const drifted_files = [];
  let file_status = "ok";
  let verdict_status = "ok";
  let verdict_drift = false;

  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    // Broken manifest → same as no-manifest
    return {
      file_status: "no-manifest",
      verdict_status: "no-manifest",
      drifted_files: [],
      verdict_drift: false,
    };
  }

  // B2: Validate manifest shape BEFORE any hash comparison.
  // Malformed manifests (e.g. {}, null, files:[null]) must NOT return "ok"
  // and must NEVER throw (FR-FORGE-003).
  if (!isValidManifestShape(manifest)) {
    return {
      file_status: "no-manifest",
      verdict_status: "no-manifest",
      drifted_files: [],
      verdict_drift: false,
    };
  }

  // Derive repo root via MANDATORY segment-wise anchoring.
  // Use resolve(verdictFile) to get the canonical absolute path, then
  // verify the manifest's verdict_file suffix-matches on segment boundaries.
  // If anchoring fails (leading .., absolute, cross-segment false match),
  // treat the manifest as unanchorable → drift.
  // NEVER fall back to process.cwd().
  const absVerdict = resolve(verdictFile);
  let repoRoot = null; // null = not yet derived, "" = anchored at root

  const verdictRel = manifest.verdict_binding.verdict_file;
  if (isSegmentAnchored(absVerdict, verdictRel)) {
    repoRoot = absVerdict.slice(0, absVerdict.length - (sep + verdictRel).length);
    // When sliced to "" (root filesystem case), use "/" so join() produces absolute paths
    if (repoRoot === "") repoRoot = "/";
  }

  // If verdict_file cannot be segment-wise anchored, mark the whole manifest
  // as drift — NO cwd fallback.
  if (repoRoot === null) {
    file_status = "drift";
    // Push all file paths as drifted since we cannot resolve them safely
    for (const entry of (Array.isArray(manifest.files) ? manifest.files : [])) {
      drifted_files.push(entry.path);
    }
  } else {
    // R4: realpath repoRoot so symlink-based escape is blocked.
    // Both sides must be realpath-resolved consistently to avoid false-drift
    // from canonicalization differences (e.g. macOS /tmp vs /private/tmp).
    let realRepoRoot;
    try {
      realRepoRoot = realpathSync(repoRoot);
    } catch {
      // Cannot realpath the anchored root — treat as unanchorable drift condition.
      // Never throw (FR-FORGE-003).
      file_status = "drift";
      for (const entry of (Array.isArray(manifest.files) ? manifest.files : [])) {
        drifted_files.push(entry.path);
      }
      return { file_status, verdict_status, drifted_files, verdict_drift };
    }

    // R5: Symmetric realpath containment for the VERDICT FILE itself.
    // Before trusting the verdict content for hash comparison, realpath the
    // verdictFile and verify the real path is UNDER realRepoRoot. If it
    // symlink-escapes to outside repoRoot, treat as verdict drift (do NOT
    // return ok). Same treatment as files[] entries in R4.
    try {
      const realVerdict = realpathSync(verdictFile);
      const realRootWithSep = realRepoRoot.endsWith(sep) ? realRepoRoot : realRepoRoot + sep;
      if (!realVerdict.startsWith(realRootWithSep) && realVerdict !== realRepoRoot) {
        // Verdict file real path is outside repoRoot → verdict drift
        verdict_status = "drift";
        verdict_drift = true;
      } else {
        // Verdict file is within repoRoot — now safe to read and hash-compare
        const verdictContent = readFileSync(verdictFile, "utf-8");
        const currentVerdictHash = sha256(verdictContent);
        if (manifest.verdict_binding.hash !== currentVerdictHash) {
          verdict_status = "drift";
          verdict_drift = true;
        }
      }
    } catch {
      // Verdict file unreadable or realpath failed → drift, never throw
      verdict_status = "drift";
      verdict_drift = true;
    }

    // Check each reviewed file hash
    if (Array.isArray(manifest.files)) {
      for (const entry of manifest.files) {
        // Validate entry.path is a clean relative descendant
        if (!isCleanDescendant(entry.path)) {
          drifted_files.push(entry.path);
          continue;
        }
        try {
          const absPath = join(repoRoot, entry.path);
          // R4: realpath the absPath to expand symlinks before bounds check.
          // realpathSync throws on broken symlink / ENOENT → treat as drift.
          let realAbsPath;
          try {
            realAbsPath = realpathSync(absPath);
          } catch {
            // Broken symlink, missing file — drift, never throw
            drifted_files.push(entry.path);
            continue;
          }
          // Defense-in-depth: verify realpath-resolved path is still under
          // the realpath-resolved repoRoot.
          const realRootWithSep = realRepoRoot.endsWith(sep) ? realRepoRoot : realRepoRoot + sep;
          if (!realAbsPath.startsWith(realRootWithSep) && realAbsPath !== realRepoRoot) {
            drifted_files.push(entry.path);
            continue;
          }
          const currentHash = sha256(readFileSync(absPath));
          if (currentHash !== entry.hash) {
            drifted_files.push(entry.path);
          }
        } catch {
          // File gone → drift
          drifted_files.push(entry.path);
        }
      }
    }
  }

  if (drifted_files.length > 0) {
    file_status = "drift";
  }

  return { file_status, verdict_status, drifted_files, verdict_drift };
}

// ── CLI entry point ──
function parseCliArgs() {
  const args = process.argv.slice(2);
  let verdict = "";
  for (const arg of args) {
    if (arg.startsWith("--verdict=")) {
      verdict = arg.slice("--verdict=".length);
    }
  }
  return { verdict };
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  const { verdict } = parseCliArgs();
  if (!verdict) {
    console.error("usage: verify-snapshot-manifest.mjs --verdict=<path>");
    process.exit(1);
  }
  const result = verifyManifest({ verdictFile: verdict });
  console.log(JSON.stringify(result));
}
