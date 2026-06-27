#!/usr/bin/env node
// generate-snapshot-manifest.mjs — FR-FORGE-001: Content-binding hash manifest for verdict
//
// Usage (module):
//   import { generateManifest } from "./generate-snapshot-manifest.mjs";
//   const manifest = generateManifest({ verdictFile, reviewedFiles, repoRoot });
//
// Usage (CLI):
//   node generate-snapshot-manifest.mjs --verdict=<path> --file=<path> [--file=<path>...] [--repo-root=<dir>]

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";

/**
 * Normalize a file path to repo-root-relative, unix slashes, no leading slash.
 */
function normalizePath(filePath, repoRoot) {
  const absFile = resolve(filePath);
  const absRoot = resolve(repoRoot);
  let rel = relative(absRoot, absFile);
  if (sep !== "/") rel = rel.replaceAll(sep, "/");
  return rel;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Generate a snapshot-manifest sidecar for a verdict file.
 *
 * @param {{ verdictFile: string, reviewedFiles: string[], repoRoot: string }} params
 * @returns {object} the manifest object (also written to <verdictFile>.snapshot-manifest)
 */
export function generateManifest({ verdictFile, reviewedFiles, repoRoot }) {
  const verdictContent = readFileSync(verdictFile, "utf-8");
  const verdictRel = normalizePath(verdictFile, repoRoot);
  const verdictHash = sha256(verdictContent);

  const files = (reviewedFiles || []).map((f) => {
    const content = readFileSync(f);
    return {
      path: normalizePath(f, repoRoot),
      hash: sha256(content),
    };
  });

  const manifest = {
    manifest_version: "1",
    hash_algorithm: "sha256",
    files,
    verdict_binding: {
      verdict_id: randomUUID(),
      verdict_file: verdictRel,
      hash: verdictHash,
    },
  };

  // Atomic write: tmp + rename
  const manifestPath = verdictFile + ".snapshot-manifest";
  const tmpPath = manifestPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, manifestPath);

  return manifest;
}

// ── CLI entry point ──
// B3: Use repeated --file=<path> args (each carries exactly one path).
// Avoids space-separated path transmission that breaks on paths with spaces.
function parseCliArgs() {
  const args = process.argv.slice(2);
  let verdict = "";
  const files = [];
  let repoRoot = process.cwd();
  for (const arg of args) {
    if (arg.startsWith("--verdict=")) {
      verdict = arg.slice("--verdict=".length);
    } else if (arg.startsWith("--file=")) {
      files.push(arg.slice("--file=".length));
    } else if (arg.startsWith("--repo-root=")) {
      repoRoot = arg.slice("--repo-root=".length);
    }
  }
  return { verdict, files, repoRoot };
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  const { verdict, files, repoRoot } = parseCliArgs();
  if (!verdict) {
    console.error("usage: generate-snapshot-manifest.mjs --verdict=<path> --file=<path> [--file=<path>...] [--repo-root=<dir>]");
    process.exit(1);
  }
  generateManifest({ verdictFile: verdict, reviewedFiles: files, repoRoot });
}
