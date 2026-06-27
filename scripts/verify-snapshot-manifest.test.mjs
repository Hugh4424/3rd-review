#!/usr/bin/env node
// verify-snapshot-manifest.test.mjs — T1-3: RED test for FR-FORGE-001/003 drift detection
//
// Tests:
//   (a) All files match → {file_status:"ok", verdict_status:"ok", drifted_files:[], verdict_drift:false}
//   (b) Reviewed file changed after manifest → {file_status:"drift", drifted_files:["<path>"], verdict_drift:false}
//   (c) Verdict JSON changed after manifest → {verdict_status:"drift", verdict_drift:true}
//   (d) No manifest → {file_status:"no-manifest", verdict_status:"no-manifest"}
//   (e) All drift cases never throw, never non-zero exit
//   B2 (Round 2):
//     (g) Malformed manifest {} → no-manifest, never throw
//     (h) Malformed manifest null → no-manifest, never throw
//     (i) Malformed manifest files:[null] → no-manifest, never throw
//     (j) Manifest with wrong manifest_version → no-manifest, never throw
//     (k) Manifest with missing verdict_file → no-manifest, never throw
//     (l) Manifest with non-hex verdict_binding.hash → no-manifest, never throw

import { verifyManifest } from "./verify-snapshot-manifest.mjs";
import assert from "node:assert";
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

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

function setupManifestDir() {
  const dir = mkdtempSync(join(tmpdir(), "vsm-test-"));
  const verdictFile = join(dir, "verdict.json");
  const reviewedA = join(dir, "file-a.md");
  const reviewedB = join(dir, "file-b.ts");
  writeFileSync(reviewedA, "content of file A");
  writeFileSync(reviewedB, "content of file B");
  return { dir, verdictFile, reviewedA, reviewedB };
}

function writeManifest(verdictFile, files, repoRoot) {
  const verdictContent = readFileSync(verdictFile, "utf-8");
  const verdictRel = verdictFile.replace(repoRoot + "/", "").replace(repoRoot, "");
  const manifest = {
    manifest_version: "1",
    hash_algorithm: "sha256",
    files: files.map((f) => ({
      path: f.replace(repoRoot + "/", "").replace(repoRoot, ""),
      hash: sha256(readFileSync(f)),
    })),
    verdict_binding: {
      verdict_id: randomUUID(),
      verdict_file: verdictRel,
      hash: sha256(verdictContent),
    },
  };
  const manifestPath = verdictFile + ".snapshot-manifest";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// ── (a) All files match ──
test("(a) all files match → file_status:ok, verdict_status:ok", () => {
  const { dir, verdictFile, reviewedA, reviewedB } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass", summary: "all good" }));
    writeManifest(verdictFile, [reviewedA, reviewedB], dir);

    const result = verifyManifest({ verdictFile });

    assert.strictEqual(result.file_status, "ok", "file_status must be 'ok'");
    assert.strictEqual(result.verdict_status, "ok", "verdict_status must be 'ok'");
    assert.deepStrictEqual(result.drifted_files, []);
    assert.strictEqual(result.verdict_drift, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (b) Reviewed file changed after manifest → file_status:"drift" ──
test("(b) reviewed file changed after manifest → file_status:drift", () => {
  const { dir, verdictFile, reviewedA, reviewedB } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeManifest(verdictFile, [reviewedA, reviewedB], dir);

    writeFileSync(reviewedA, "TAMPERED content of file A — this is a drift");

    const result = verifyManifest({ verdictFile });

    assert.strictEqual(result.file_status, "drift", "file_status must be 'drift'");
    assert.ok(result.drifted_files.includes("file-a.md"), "file-a.md must be in drifted_files");
    assert.strictEqual(result.verdict_drift, false);
    assert.strictEqual(result.verdict_status, "ok", "verdict_status still ok when only file drifted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (c) Verdict JSON changed after manifest → verdict_status:"drift" ──
test("(c) verdict JSON changed after manifest → verdict_status:drift", () => {
  const { dir, verdictFile, reviewedA } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeManifest(verdictFile, [reviewedA], dir);

    writeFileSync(verdictFile, JSON.stringify({ verdict: "revise_required", tampered: true }));

    const result = verifyManifest({ verdictFile });

    assert.strictEqual(result.verdict_status, "drift", "verdict_status must be 'drift'");
    assert.strictEqual(result.verdict_drift, true);
    assert.strictEqual(result.file_status, "ok", "file_status must be 'ok' when only verdict drifted");
    assert.deepStrictEqual(result.drifted_files, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (d) No manifest → no-manifest ──
test("(d) no manifest → file_status:no-manifest, verdict_status:no-manifest", () => {
  const { dir, verdictFile } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));

    const result = verifyManifest({ verdictFile });

    assert.strictEqual(result.file_status, "no-manifest", "file_status must be 'no-manifest'");
    assert.strictEqual(result.verdict_status, "no-manifest", "verdict_status must be 'no-manifest'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (e) All drift cases never throw ──
test("(e) drift never throws — both file and verdict drifted simultaneously", () => {
  const { dir, verdictFile, reviewedA, reviewedB } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeManifest(verdictFile, [reviewedA, reviewedB], dir);

    writeFileSync(reviewedA, "TAMPERED A");
    writeFileSync(reviewedB, "TAMPERED B");
    writeFileSync(verdictFile, JSON.stringify({ verdict: "revise_required", tampered: true }));

    const result = verifyManifest({ verdictFile });

    assert.strictEqual(result.file_status, "drift");
    assert.strictEqual(result.verdict_status, "drift");
    assert.strictEqual(result.verdict_drift, true);
    assert.strictEqual(result.drifted_files.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (f) Drift path does not cause throw ──
test("(f) drift path does not cause throw", () => {
  const { dir, verdictFile, reviewedA } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeManifest(verdictFile, [reviewedA], dir);
    writeFileSync(reviewedA, "TAMPERED");

    let threw = false;
    try {
      verifyManifest({ verdictFile });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, "verifyManifest must never throw, even on drift");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── B2 (Round 2): Malformed manifest tests ──

// Write a raw (malformed) manifest sidecar — caller controls the JSON object.
function writeRawManifest(verdictFile, obj) {
  const manifestPath = verdictFile + ".snapshot-manifest";
  writeFileSync(manifestPath, JSON.stringify(obj, null, 2) + "\n");
}

// Helper: good manifest shape for a single file
function writeGoodManifest(repoRoot, verdictFile, reviewedFile) {
  const dir = repoRoot;
  writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
  writeFileSync(reviewedFile, "hello");
  return writeManifest(verdictFile, [reviewedFile], dir);
}

test("(g) B2: empty object {} → no-manifest, never throw", () => {
  const { dir, verdictFile } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeRawManifest(verdictFile, {});

    const result = verifyManifest({ verdictFile });
    assert.strictEqual(result.file_status, "no-manifest", "{} must be no-manifest");
    assert.strictEqual(result.verdict_status, "no-manifest");
    assert.deepStrictEqual(result.drifted_files, []);
    assert.strictEqual(result.verdict_drift, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(h) B2: null JSON content → no-manifest, never throw", () => {
  const { dir, verdictFile } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeRawManifest(verdictFile, null);

    const result = verifyManifest({ verdictFile });
    assert.strictEqual(result.file_status, "no-manifest", "null must be no-manifest");
    assert.strictEqual(result.verdict_status, "no-manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i) B2: files:[null] → no-manifest, never throw", () => {
  const { dir, verdictFile, reviewedA } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(reviewedA, "hello");
    // Construct manifest with valid top-level fields but null file entry (B2 repro)
    const verdictContent = readFileSync(verdictFile, "utf-8");
    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [null],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "verdict.json",
        hash: sha256(verdictContent),
      },
    };
    writeRawManifest(verdictFile, badManifest);

    const result = verifyManifest({ verdictFile });
    assert.strictEqual(result.file_status, "no-manifest", "files:[null] must be no-manifest — not ok, not throw");
    assert.strictEqual(result.verdict_status, "no-manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(j) B2: wrong manifest_version → no-manifest, never throw", () => {
  const { dir, verdictFile, reviewedA } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(reviewedA, "hello");
    const verdictContent = readFileSync(verdictFile, "utf-8");
    const badManifest = {
      manifest_version: "2",
      hash_algorithm: "sha256",
      files: [{ path: "file-a.md", hash: sha256(readFileSync(reviewedA)) }],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "verdict.json",
        hash: sha256(verdictContent),
      },
    };
    writeRawManifest(verdictFile, badManifest);

    const result = verifyManifest({ verdictFile });
    assert.strictEqual(result.file_status, "no-manifest", "wrong version must be no-manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(k) B2: missing verdict_file → no-manifest, never throw", () => {
  const { dir, verdictFile, reviewedA } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(reviewedA, "hello");
    const verdictContent = readFileSync(verdictFile, "utf-8");
    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [{ path: "file-a.md", hash: sha256(readFileSync(reviewedA)) }],
      verdict_binding: {
        verdict_id: randomUUID(),
        // verdict_file intentionally missing
        hash: sha256(verdictContent),
      },
    };
    writeRawManifest(verdictFile, badManifest);

    const result = verifyManifest({ verdictFile });
    assert.strictEqual(result.file_status, "no-manifest", "missing verdict_file must be no-manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(l) B2: non-hex verdict_binding.hash → no-manifest, never throw", () => {
  const { dir, verdictFile, reviewedA } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass" }));
    writeFileSync(reviewedA, "hello");
    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [{ path: "file-a.md", hash: sha256(readFileSync(reviewedA)) }],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "verdict.json",
        hash: "not-a-hex-string",
      },
    };
    writeRawManifest(verdictFile, badManifest);

    const result = verifyManifest({ verdictFile });
    assert.strictEqual(result.file_status, "no-manifest", "non-hex hash must be no-manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Summary ──
console.log(`\nverify-snapshot-manifest.test.mjs: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
