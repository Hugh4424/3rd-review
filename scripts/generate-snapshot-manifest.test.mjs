#!/usr/bin/env node
// generate-snapshot-manifest.test.mjs — T1-1: RED test for FR-FORGE-001 manifest shape
//
// Tests:
//   1. generateManifest produces <verdictFile>.snapshot-manifest with exact frozen shape
//   2. files[].hash are valid 64-char sha256 hex strings
//   3. verdict_binding.hash is valid 64-char sha256 hex
//   4. manifest_version === "1"
//   5. hash_algorithm === "sha256"
//   6. verdict_binding.verdict_id is non-empty string
//   7. Atomic write: manifest file only appears at final path, not .tmp path

import { generateManifest } from "./generate-snapshot-manifest.mjs";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
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

function setupDir() {
  const dir = mkdtempSync(join(tmpdir(), "gsm-test-"));
  // Create a flat dir structure as a repo-like workspace
  const verdictFile = join(dir, "verdict.json");
  const inputMd = join(dir, "input.md");
  const srcDir = join(dir, "src");
  mkdirSync(srcDir, { recursive: true });
  const srcTs = join(dir, "src", "app.ts");
  return { dir, verdictFile, inputMd, srcTs, srcDir };
}

// ── Shape assertions ──

test("generates manifest at verdictFile.snapshot-manifest with exact frozen shape", () => {
  const { dir, verdictFile, inputMd, srcTs } = setupDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass", summary: "ok" }));
    writeFileSync(inputMd, "test input content");

    // Note: generateManifest uses repo-root-relative paths.
    // We pass dir as the effective repo root for path normalization.
    const result = generateManifest({
      verdictFile,
      reviewedFiles: [inputMd],
      repoRoot: dir,
    });

    const manifestPath = verdictFile + ".snapshot-manifest";
    assert.ok(existsSync(manifestPath), `manifest not found at ${manifestPath}`);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

    // Top-level structure
    assert.strictEqual(manifest.manifest_version, "1");
    assert.strictEqual(manifest.hash_algorithm, "sha256");
    assert.ok(Array.isArray(manifest.files), "files must be an array");
    assert.ok(typeof manifest.verdict_binding === "object" && manifest.verdict_binding !== null, "verdict_binding must be an object");

    // verdict_binding fields
    assert.ok(typeof manifest.verdict_binding.verdict_id === "string" && manifest.verdict_binding.verdict_id.length > 0, "verdict_id must be non-empty string");
    assert.ok(typeof manifest.verdict_binding.verdict_file === "string", "verdict_file must be a string");
    assert.ok(typeof manifest.verdict_binding.hash === "string", "verdict_binding.hash must be a string");

    // Return value matches manifest content
    assert.deepStrictEqual(result, manifest, "return value must match manifest file content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files[].hash are valid 64-char sha256 hex", () => {
  const { dir, verdictFile, inputMd } = setupDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(inputMd, "test input content");

    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [inputMd],
      repoRoot: dir,
    });

    for (const f of manifest.files) {
      assert.match(f.hash, /^[0-9a-f]{64}$/, `file hash "${f.hash}" is not valid sha256 hex`);
    }
    assert.match(manifest.verdict_binding.hash, /^[0-9a-f]{64}$/, `verdict_binding.hash "${manifest.verdict_binding.hash}" is not valid sha256 hex`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest_version === '1' and hash_algorithm === 'sha256'", () => {
  const { dir, verdictFile, inputMd } = setupDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(inputMd, "test");

    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [inputMd],
      repoRoot: dir,
    });

    assert.strictEqual(manifest.manifest_version, "1");
    assert.strictEqual(manifest.hash_algorithm, "sha256");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verdict_binding.verdict_id is non-empty string", () => {
  const { dir, verdictFile, inputMd } = setupDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(inputMd, "test");

    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [inputMd],
      repoRoot: dir,
    });

    assert.ok(typeof manifest.verdict_binding.verdict_id === "string");
    assert.ok(manifest.verdict_binding.verdict_id.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files[].path are normalized repo-root-relative unix paths, no leading slash", () => {
  const { dir, verdictFile, inputMd, srcTs } = setupDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(inputMd, "test input");

    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [inputMd],
      repoRoot: dir,
    });

    for (const f of manifest.files) {
      assert.ok(!f.path.startsWith("/"), `path "${f.path}" must not start with /`);
      assert.ok(!f.path.includes("\\"), `path "${f.path}" must use unix slashes`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verdict_binding.hash matches sha256 of verdict file bytes", () => {
  const { dir, verdictFile, inputMd } = setupDir();
  try {
    const verdictContent = JSON.stringify({ verdict: "pass", summary: "ok" });
    writeFileSync(verdictFile, verdictContent);
    writeFileSync(inputMd, "test");

    const expectedHash = sha256(verdictContent);
    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [inputMd],
      repoRoot: dir,
    });

    assert.strictEqual(manifest.verdict_binding.hash, expectedHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic write: manifest final path exists, no stray .tmp artifact", () => {
  const { dir, verdictFile, inputMd } = setupDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(inputMd, "test");

    generateManifest({
      verdictFile,
      reviewedFiles: [inputMd],
      repoRoot: dir,
    });

    const manifestPath = verdictFile + ".snapshot-manifest";
    assert.ok(existsSync(manifestPath), "final manifest path must exist");

    // Check no .tmp file lingering (tmp file pattern)
    const tmpPattern = manifestPath + ".tmp";
    assert.ok(!existsSync(tmpPattern), `tmp file ${tmpPattern} should not exist after atomic write`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple reviewed files → all in files array with correct hashes", () => {
  const { dir, verdictFile, inputMd, srcTs, srcDir } = setupDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(inputMd, "input content");
    writeFileSync(srcTs, "const x = 1;");

    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [inputMd, srcTs],
      repoRoot: dir,
    });

    assert.strictEqual(manifest.files.length, 2, "must have 2 file entries");

    const inputHash = sha256("input content");
    const srcHash = sha256("const x = 1;");

    const inputEntry = manifest.files.find(f => f.path === "input.md");
    const srcEntry = manifest.files.find(f => f.path === "src/app.ts");

    assert.ok(inputEntry, "input.md entry must exist");
    assert.ok(srcEntry, "src/app.ts entry must exist");
    assert.strictEqual(inputEntry.hash, inputHash);
    assert.strictEqual(srcEntry.hash, srcHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty reviewedFiles → files is empty array", () => {
  const { dir, verdictFile } = setupDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));

    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [],
      repoRoot: dir,
    });

    assert.ok(Array.isArray(manifest.files));
    assert.strictEqual(manifest.files.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FR-FORGE-001 R2: verdictFile === reviewedFile (same absolute path) ──
// Regression: commonAncestorDir over FULL FILE paths (not dirname) returns the file
// itself as root → both paths become "" → verifier treats manifest as malformed.
// Fix must compute common ancestor from DIRECTORY paths.

test("FR-FORGE-001 R2: verdictFile === reviewed file (same abs path) → non-empty clean relative paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsm-samefile-"));
  try {
    const verdictFile = join(dir, "verdict.json");
    const content = JSON.stringify({ verdict: "pass", summary: "self-review" });
    writeFileSync(verdictFile, content);

    // Deliberately: the verdict IS the reviewed file — same absolute path
    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [verdictFile],
      repoRoot: dir,
    });

    const expectedHash = sha256(content);

    // verdict_binding.verdict_file must be non-empty and clean (just the basename here)
    assert.ok(typeof manifest.verdict_binding.verdict_file === "string", "verdict_file must be a string");
    assert.ok(manifest.verdict_binding.verdict_file.length > 0, "verdict_file must be non-empty");
    assert.ok(!manifest.verdict_binding.verdict_file.includes(".."), "verdict_file must not contain '..'");
    assert.ok(!manifest.verdict_binding.verdict_file.startsWith("/"), "verdict_file must be relative");

    // files[0] path must be clean relative and non-empty
    assert.strictEqual(manifest.files.length, 1, "must have 1 file entry");
    const entry = manifest.files[0];
    assert.ok(entry.path.length > 0, "files[0].path must be non-empty");
    assert.ok(!entry.path.includes(".."), "files[0].path must not contain '..'");
    assert.ok(!entry.path.startsWith("/"), "files[0].path must be relative");

    // Hash correctness
    assert.strictEqual(entry.hash, expectedHash, "file hash must match");
    assert.strictEqual(manifest.verdict_binding.hash, expectedHash, "verdict_binding.hash must match");

    // Verify round-trip: manifest on disk is well-shaped and verifiable
    const manifestPath = verdictFile + ".snapshot-manifest";
    assert.ok(existsSync(manifestPath), "manifest must exist on disk");

    // Verify the written manifest passes shape validation (no empty-string paths)
    const written = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.strictEqual(written.manifest_version, "1");
    assert.ok(Array.isArray(written.files));
    assert.ok(written.files.length > 0, "written files must be non-empty");
    assert.ok(written.files[0].path.length > 0, "written files[0].path must be non-empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── B3 (Round 2): Space-in-path test ──

test("B3: file path with space → correctly hashed (no split/ENOENT)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsm-space-"));
  try {
    const dirWithSpace = join(dir, "dir with space");
    mkdirSync(dirWithSpace, { recursive: true });
    const verdictFile = join(dir, "verdict.json");
    const fileWithSpace = join(dirWithSpace, "my file.txt");
    const content = "content with spaces in filename";
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(fileWithSpace, content);

    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [fileWithSpace],
      repoRoot: dir,
    });

    assert.strictEqual(manifest.files.length, 1);
    const entry = manifest.files[0];
    // Path must be normalized (unix slashes, no leading slash)
    assert.ok(!entry.path.startsWith("/"), "path must not start with /");
    assert.ok(!entry.path.includes("\\"), "path must use unix slashes");
    assert.ok(entry.path.includes("dir with space"), "path must contain space");
    assert.match(entry.hash, /^[0-9a-f]{64}$/, "hash must be valid sha256 hex");
    // Verify hash correctness against known content
    assert.strictEqual(entry.hash, sha256(content));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1/B3: empty reviewedFiles → manifest still generated with verdict binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsm-empty-"));
  try {
    const verdictFile = join(dir, "verdict.json");
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));

    const manifest = generateManifest({
      verdictFile,
      reviewedFiles: [],
      repoRoot: dir,
    });

    // Manifest must exist and bind the verdict even with no reviewed files (B1)
    assert.ok(Array.isArray(manifest.files));
    assert.strictEqual(manifest.files.length, 0);
    assert.strictEqual(manifest.manifest_version, "1");
    assert.strictEqual(manifest.hash_algorithm, "sha256");
    assert.ok(typeof manifest.verdict_binding.verdict_id === "string" && manifest.verdict_binding.verdict_id.length > 0);
    assert.strictEqual(manifest.verdict_binding.hash, sha256(readFileSync(verdictFile, "utf-8")));

    // Verify file was written to disk
    const manifestPath = verdictFile + ".snapshot-manifest";
    assert.ok(existsSync(manifestPath), "manifest file must exist even with empty reviewedFiles");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── REGRESSION: isMain() safe import with nonexistent argv[1] — no ENOENT crash ──
// RED before fix: realpathSync(resolve(process.argv[1])) threw ENOENT at module top-level, crashing import.
// GREEN after fix: isMain() is a guarded function with try/catch + argv check.
test("isMain() safe import with nonexistent argv[1] — no ENOENT crash", () => {
  const scriptPath = fileURLToPath(new URL("./generate-snapshot-manifest.mjs", import.meta.url));
  const result = execFileSync(
    process.execPath,
    ["-e",
     `process.argv[1]='/nonexistent/generate-snapshot-manifest-import-test.mjs';` +
     `import('${scriptPath}')` +
     `.then(()=>console.log('IMPORT_OK')).catch(e=>{console.error('IMPORT_FAIL');process.exit(1)})`
    ],
    { encoding: "utf8" }
  ).trim();
  assert.strictEqual(result, "IMPORT_OK",
    `import must succeed even with nonexistent argv[1]; got ${result}`);
});

// ── Summary ──
console.log(`\ngenerate-snapshot-manifest.test.mjs: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
