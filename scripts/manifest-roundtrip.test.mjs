#!/usr/bin/env node
// manifest-roundtrip.test.mjs — REGRESSION: cross-tree manifest round-trip
//
// The bug (FR-FORGE-001): when verdict file lives OUTSIDE the caller-supplied
// repo-root (common in standalone.sh with --output-root), the generator produces
// a verdict_binding.verdict_file with "../.." escaping — which breaks the
// verifier's repoRoot derivation (`endsWith` fails) and causes FALSE "drift"
// when run from any cwd other than the input directory.
//
// Tests:
//   (R1) Cross-tree: verdict outside reviewed file dir → verify from neutral cwd → file_status:ok
//   (R2) Cross-tree + content mutation → verify from neutral cwd → file_status:drift
//   (R3) Cross-tree: no `..` in any manifest path (all paths are clean descendants of common ancestor)

import { generateManifest } from "./generate-snapshot-manifest.mjs";
import { verifyManifest } from "./verify-snapshot-manifest.mjs";
import assert from "node:assert";
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    fail++;
    console.error(`  [FAIL] ${name} — ${e.message}`);
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// ── Setup: cross-tree — verdict in one subtree, reviewed file in another ──
function setupCrossTree() {
  const base = mkdtempSync(join(tmpdir(), "mrt-cross-"));
  // reviewed file lives under base/input-dir/
  const inputDir = join(base, "input-dir");
  mkdirSync(inputDir, { recursive: true });
  const reviewedFile = join(inputDir, "input.md");
  writeFileSync(reviewedFile, "original content for cross-tree test");

  // verdict lives under base/output-dir/tasks/<uuid>/reviews/
  const reviewsDir = join(base, "output-dir", "tasks", "abc123", "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  const verdictFile = join(reviewsDir, "verdict.json");
  writeFileSync(verdictFile, JSON.stringify({ verdict: "pass", summary: "cross-tree ok" }));

  return { base, inputDir, reviewedFile, verdictFile, reviewsDir };
}

// ── (R1) Cross-tree: verify from neutral cwd → file_status:ok ──
test("(R1) cross-tree round-trip: verdict outside reviewed file dir → file_status ok from neutral cwd", () => {
  const { base, reviewedFile, verdictFile } = setupCrossTree();
  try {
    // Generate manifest: caller passes inputDir as repo-root (the historic pattern)
    // NOTE: with the fix, the generator must compute commonAncestor internally
    // so this test verifies the fix works even when the old-style caller arg is passed.
    generateManifest({
      verdictFile,
      reviewedFiles: [reviewedFile],
      repoRoot: resolve(reviewedFile, ".."), // caller supplies input dir
    });

    // Verify from a NEUTRAL cwd (os.tmpdir) — NOT the input dir
    const origCwd = process.cwd();
    process.chdir(tmpdir());
    const result = verifyManifest({ verdictFile });
    process.chdir(origCwd);

    assert.strictEqual(result.file_status, "ok",
      `expected file_status "ok" but got "${result.file_status}" from neutral cwd`);
    assert.strictEqual(result.verdict_status, "ok");
    assert.deepStrictEqual(result.drifted_files, [],
      "drifted_files must be empty when content is byte-identical");
    assert.strictEqual(result.verdict_drift, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── (R2) Cross-tree + content mutation → file_status:drift ──
test("(R2) cross-tree + content mutation → still detects drift from neutral cwd", () => {
  const { base, reviewedFile, verdictFile } = setupCrossTree();
  try {
    generateManifest({
      verdictFile,
      reviewedFiles: [reviewedFile],
      repoRoot: resolve(reviewedFile, ".."),
    });

    // Mutate the reviewed file AFTER manifest generation
    writeFileSync(reviewedFile, "TAMPERED content — drift must be detected");

    const origCwd = process.cwd();
    process.chdir(tmpdir());
    const result = verifyManifest({ verdictFile });
    process.chdir(origCwd);

    assert.strictEqual(result.file_status, "drift",
      `expected file_status "drift" but got "${result.file_status}" — mutation must be detected`);
    assert.ok(result.drifted_files.length > 0, "drifted_files must be non-empty on mutation");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── (R3) No `..` in any manifest path ──
test("(R3) cross-tree manifest: no '..' path segments in files[].path or verdict_binding.verdict_file", () => {
  const { base, reviewedFile, verdictFile } = setupCrossTree();
  try {
    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [reviewedFile],
      repoRoot: resolve(reviewedFile, ".."),
    });

    // Read the written manifest from disk
    const manifestPath = verdictFile + ".snapshot-manifest";
    const written = JSON.parse(readFileSync(manifestPath, "utf-8"));

    for (const f of written.files) {
      assert.ok(!f.path.includes(".."),
        `files[].path "${f.path}" must NOT contain '..' — all paths must be clean descendants`);
    }
    assert.ok(!written.verdict_binding.verdict_file.includes(".."),
      `verdict_binding.verdict_file "${written.verdict_binding.verdict_file}" must NOT contain '..'`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── (R4) FR-FORGE-001 R2: verdictFile === reviewedFile (same abs path) → roundtrip ok ──
test("(R4) roundtrip with verdictFile === reviewedFile (same abs path) → file_status ok from neutral cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "mrt-samefile-"));
  try {
    const verdictFile = join(dir, "verdict.json");
    const content = JSON.stringify({ verdict: "pass", summary: "self-review" });
    writeFileSync(verdictFile, content);

    // Generate manifest where the verdict IS the reviewed file
    generateManifest({
      verdictFile,
      reviewedFiles: [verdictFile],
      repoRoot: dir,
    });

    // Verify from neutral cwd
    const origCwd = process.cwd();
    process.chdir(tmpdir());
    const result = verifyManifest({ verdictFile });
    process.chdir(origCwd);

    assert.strictEqual(result.file_status, "ok",
      `expected file_status "ok" but got "${result.file_status}" — same-file roundtrip failed`);
    assert.strictEqual(result.verdict_status, "ok");
    assert.deepStrictEqual(result.drifted_files, []);
    assert.strictEqual(result.verdict_drift, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Summary ──
console.log(`\nmanifest-roundtrip.test.mjs: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
