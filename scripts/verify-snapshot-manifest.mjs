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

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

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

  // Check verdict file hash against manifest.verdict_binding.hash
  try {
    const verdictContent = readFileSync(verdictFile, "utf-8");
    const currentVerdictHash = sha256(verdictContent);
    if (manifest.verdict_binding.hash !== currentVerdictHash) {
      verdict_status = "drift";
      verdict_drift = true;
    }
  } catch {
    // If verdict file is unreadable after manifest was written, that's a drift condition
    verdict_status = "drift";
    verdict_drift = true;
  }

  // Derive repo root: verdictFile absolute path minus its relative path from manifest
  let repoRoot = "";
  if (manifest.verdict_binding && manifest.verdict_binding.verdict_file) {
    const verdictRel = manifest.verdict_binding.verdict_file;
    const absVerdict = verdictFile;
    if (absVerdict.endsWith(verdictRel)) {
      repoRoot = absVerdict.slice(0, absVerdict.length - verdictRel.length);
    }
  }

  // Check each reviewed file hash
  if (Array.isArray(manifest.files)) {
    for (const entry of manifest.files) {
      try {
        const absPath = repoRoot ? join(repoRoot, entry.path) : entry.path;
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
