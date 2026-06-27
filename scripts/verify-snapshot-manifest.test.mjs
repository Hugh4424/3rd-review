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
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
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

// ── FR-FORGE-001 R2 B1: Mandatory root anchoring + no cwd fallback ──
// Bug: repoRoot derivation uses raw String.endsWith; when verdict_file doesn't
// segment-suffix-match the resolved verdictFile path, repoRoot="" and entry.path
// is resolved relative to process.cwd() — a decoy file under cwd with matching
// hash can produce a false "ok". Fix: mandatory segment-wise anchoring; if
// verdict_file can't be anchored (leading .., absolute, or non-matching suffix),
// return drift immediately. Also validate each entry.path is a clean relative
// descendant (no leading .., not absolute).

function writeForgeTestManifest(verdictFile, manifest) {
  const manifestPath = verdictFile + ".snapshot-manifest";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

test("(m) FR-FORGE-001 R2 B1: verdict_file with leading '..' → drift, cwd decoy NOT read", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsm-forge1-"));
  try {
    const verdictFile = join(dir, "verdict.json");
    const verdictContent = JSON.stringify({ verdict: "pass" });
    writeFileSync(verdictFile, verdictContent);

    // Plant a DECOY file in tmpdir() with a known hash — if the verifier
    // falls back to cwd, it WILL find this decoy and return "ok"
    const decoyName = "forge-r2-decoy.txt";
    const decoyContent = "DECOY — this file should NEVER be read";
    const decoyHash = sha256(decoyContent);
    const decoyAbs = join(tmpdir(), decoyName);

    // Also plant a matching-hash decoy at the unresolved entry.path (relative
    // to cwd), so even raw entry.path reads succeed if cwd fallback triggers.
    const origCwd = process.cwd();
    try {
      // Plant decoy in tmpdir() — where verify will run
      writeFileSync(decoyAbs, decoyContent);

      // Construct a valid-shaped manifest whose verdict_file has leading ".."
      // and files[0].path = decoyName (the decoy in tmpdir cwd)
      const badManifest = {
        manifest_version: "1",
        hash_algorithm: "sha256",
        files: [
          { path: decoyName, hash: decoyHash },
        ],
        verdict_binding: {
          verdict_id: randomUUID(),
          verdict_file: "../../etc/passwd", // leading ".." — unanchorable
          hash: sha256(verdictContent),
        },
      };
      writeForgeTestManifest(verdictFile, badManifest);

      // Run verify from tmpdir() — the decoy IS there, so cwd fallback WOULD find it
      process.chdir(tmpdir());
      const result = verifyManifest({ verdictFile });
      process.chdir(origCwd);

      // Must be drift, NOT ok — unanchorable verdict_file must be rejected
      // even when a matching-hash decoy exists in cwd
      assert.notStrictEqual(result.file_status, "ok",
        `unanchorable verdict_file (leading '..') must NOT return ok — got ${result.file_status}`);
    } finally {
      process.chdir(origCwd);
      try { rmSync(decoyAbs, { force: true }); } catch {}
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(n) FR-FORGE-001 R2 B1: verdict_file cross-segment false match → drift (unanchorable)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsm-forge2-"));
  try {
    // Make verdictFile path end with ".../abc/verdict.json"
    const subdir = join(dir, "abc");
    mkdirSync(subdir, { recursive: true });
    const verdictFile = join(subdir, "verdict.json");
    const verdictContent = JSON.stringify({ verdict: "pass" });
    writeFileSync(verdictFile, verdictContent);

    // verdict_file="bc/verdict.json" will raw String.endsWith match
    // ".../abc/verdict.json" because the last 16 chars ARE "bc/verdict.json"
    // BUT the segment boundary is at "abc" not "bc" — so anchoring must reject it.
    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [
        { path: "nonexistent-file.txt", hash: "a".repeat(64) },
      ],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "bc/verdict.json", // cross-segment false match with .../abc/verdict.json
        hash: sha256(verdictContent),
      },
    };
    writeForgeTestManifest(verdictFile, badManifest);

    const result = verifyManifest({ verdictFile });

    // Must be drift/no-manifest, NOT ok — cross-segment false match must be rejected
    assert.notStrictEqual(result.file_status, "ok",
      `verdict_file with cross-segment false match must NOT return ok — got ${result.file_status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(o) FR-FORGE-001 R2 B1: absolute verdict_file → drift (unanchorable)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsm-forge3-"));
  try {
    const verdictFile = join(dir, "verdict.json");
    const verdictContent = JSON.stringify({ verdict: "pass" });
    writeFileSync(verdictFile, verdictContent);

    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [
        { path: "nonexistent.txt", hash: "a".repeat(64) },
      ],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "/etc/passwd", // absolute path — unanchorable as relative
        hash: sha256(verdictContent),
      },
    };
    writeForgeTestManifest(verdictFile, badManifest);

    const result = verifyManifest({ verdictFile });
    assert.notStrictEqual(result.file_status, "ok",
      "absolute verdict_file must NOT return ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(p) FR-FORGE-001 R2 B1: entry.path with leading '..' → that file is drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsm-forge4-"));
  try {
    const verdictFile = join(dir, "verdict.json");
    const verdictContent = JSON.stringify({ verdict: "pass" });
    writeFileSync(verdictFile, verdictContent);

    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [
        { path: "../etc/passwd", hash: "a".repeat(64) },
      ],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "verdict.json", // correctly anchored
        hash: sha256(verdictContent),
      },
    };
    writeForgeTestManifest(verdictFile, badManifest);

    const result = verifyManifest({ verdictFile });
    // verdict_file anchors, but entry.path has ".." — must be caught as drift
    // file_status could be drift (path unreadable/escaping) and verdict_status could be ok
    assert.ok(result.file_status === "drift" || result.file_status === "no-manifest",
      "entry.path with leading '..' must be treated as drift (not silently read from cwd)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FR-FORGE-001 R3: Internal ".." segment traversal anti-forge hole ──
// Bug: isCleanDescendant() only rejects LEADING ".." and absolute paths.
// A forged entry.path like "safe/../../outside.txt" passes isCleanDescendant
// but join(repoRoot, entry.path) normalizes the two ".." segments — the first
// cancels "safe", the second escapes one level above repoRoot — reading a file
// OUTSIDE the anchored tree.  Fix: reject ANY path containing a ".." segment,
// plus defense-in-depth: verify resolved absPath is still under repoRoot.

test("(q) FR-FORGE-001 R3: entry.path 'safe/../../outside.txt' → drift (internal .. traversal blocked)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsm-traverse-"));
  try {
    const verdictFile = join(dir, "verdict.json");
    const verdictContent = JSON.stringify({ verdict: "pass" });
    writeFileSync(verdictFile, verdictContent);

    // Plant a file OUTSIDE the anchored repoRoot.
    // repoRoot = dir (from verdict_file:"verdict.json" segment-anchored at dir).
    // join(dir, "safe/../../outside.txt") → dir/safe/../../outside.txt
    //   → dir/../outside.txt → tmpdir()/outside.txt — ESCAPES.
    const outsideFile = join(tmpdir(), "vsmt-outside.txt");
    const outsideContent = "FORGED — this file lives OUTSIDE the anchored repoRoot";
    const outsideHash = sha256(outsideContent);
    writeFileSync(outsideFile, outsideContent);

    const maliciousPath = "safe/../../vsmt-outside.txt";
    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [
        { path: maliciousPath, hash: outsideHash },
      ],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "verdict.json", // correctly segment-anchored at dir
        hash: sha256(verdictContent),
      },
    };
    writeForgeTestManifest(verdictFile, badManifest);

    const result = verifyManifest({ verdictFile });

    // Must be drift — internal ".." must be caught, NOT silently read the escaped file.
    assert.strictEqual(result.file_status, "drift",
      `entry.path with internal '..' must return drift, got "${result.file_status}"`);
    assert.ok(
      result.drifted_files.includes(maliciousPath),
      `drifted_files must contain "${maliciousPath}", got [${result.drifted_files.join(", ")}]`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    try { rmSync(join(tmpdir(), "vsmt-outside.txt"), { force: true }); } catch {}
  }
});

test("(r) FR-FORGE-001 R3: plain '..' entry.path → drift (already caught, regression safe)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsm-plaindot-"));
  try {
    const verdictFile = join(dir, "verdict.json");
    const verdictContent = JSON.stringify({ verdict: "pass" });
    writeFileSync(verdictFile, verdictContent);

    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [
        { path: "..", hash: "a".repeat(64) },
      ],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "verdict.json",
        hash: sha256(verdictContent),
      },
    };
    writeForgeTestManifest(verdictFile, badManifest);

    const result = verifyManifest({ verdictFile });
    assert.ok(result.file_status === "drift" || result.file_status === "no-manifest",
      `path ".." must be drift, got "${result.file_status}"`);
    assert.ok(result.drifted_files.includes(".."),
      `drifted_files must contain "..", got [${result.drifted_files.join(", ")}]`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FR-FORGE-001 R4: Symlink escape bypasses resolve()-only bounds check ──
// Bug: resolve(absPath) is LEXICAL normalization only — it does NOT expand symlinks.
// A clean repo-internal path like "link.txt" (passes isCleanDescendant, resolve stays under
// repoRoot) can be a SYMLINK to a file OUTSIDE repoRoot, and readFileSync follows the symlink,
// reading the outside content and returning file_status:"ok".
// Fix: realpathSync BOTH sides before bounds check; broken symlink → drift; never throws.

import { symlinkSync } from "node:fs";

test("(R4-symlink) symlink escape: internal symlink to outside file → drift, NOT ok", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "vsm-symlink-repo-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "vsm-symlink-outside-"));
  try {
    const verdictFile = join(repoDir, "verdict.json");
    const verdictContent = JSON.stringify({ verdict: "pass" });
    writeFileSync(verdictFile, verdictContent);

    // Outside file with known content — must never be read as "ok"
    const outsideFile = join(outsideDir, "secret.txt");
    const outsideContent = "ESCAPED — this file is outside repoRoot";
    const outsideHash = sha256(outsideContent);
    writeFileSync(outsideFile, outsideContent);

    // Symlink inside repoDir pointing to outside file
    const symlinkPath = join(repoDir, "link.txt");
    symlinkSync(outsideFile, symlinkPath);

    // Manifest claims link.txt has the outside file's hash, verdict_file anchored correctly
    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [
        { path: "link.txt", hash: outsideHash },
      ],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "verdict.json",
        hash: sha256(verdictContent),
      },
    };
    const manifestPath = verdictFile + ".snapshot-manifest";
    writeFileSync(manifestPath, JSON.stringify(badManifest, null, 2) + "\n");

    const result = verifyManifest({ verdictFile });

    // Must be drift — symlink escape must be caught, NOT returned as "ok"
    assert.strictEqual(result.file_status, "drift",
      `symlink escape must return drift, got "${result.file_status}"`);
    assert.ok(
      result.drifted_files.includes("link.txt"),
      `drifted_files must contain "link.txt", got [${result.drifted_files.join(", ")}]`
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("(R4-broken-symlink) broken symlink → drift (ENOENT treated as drift, never throws)", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "vsm-broken-symlink-"));
  try {
    const verdictFile = join(repoDir, "verdict.json");
    const verdictContent = JSON.stringify({ verdict: "pass" });
    writeFileSync(verdictFile, verdictContent);

    // Create a broken symlink (points to nonexistent file)
    const brokenTarget = join(repoDir, "nonexistent-target");
    const symlinkPath = join(repoDir, "broken-link.txt");
    symlinkSync(brokenTarget, symlinkPath);

    const someHash = "a".repeat(64);
    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [
        { path: "broken-link.txt", hash: someHash },
      ],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "verdict.json",
        hash: sha256(verdictContent),
      },
    };
    const manifestPath = verdictFile + ".snapshot-manifest";
    writeFileSync(manifestPath, JSON.stringify(badManifest, null, 2) + "\n");

    let threw = false;
    let result;
    try {
      result = verifyManifest({ verdictFile });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, "broken symlink must never throw");
    assert.notStrictEqual(result.file_status, "ok",
      `broken symlink must NOT return ok, got "${result.file_status}"`);
    assert.ok(
      result.drifted_files.includes("broken-link.txt"),
      `broken symlink must be in drifted_files, got [${result.drifted_files.join(", ")}]`
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── macOS realpath consistency guard ──
// On macOS, /tmp is a symlink to /private/tmp. If we realpath only the file but
// NOT the repoRoot, a legitimate non-symlink file would appear to be outside
// the un-realpathed repoRoot. This test ensures same-dir normal files still verify ok.
test("(R4-normal-same-dir) normal non-symlink file in same real dir → still ok (no realpath false-drift)", () => {
  const { dir, verdictFile, reviewedA, reviewedB } = setupManifestDir();
  try {
    writeFileSync(verdictFile, JSON.stringify({ verdict: "pass", summary: "all good" }));
    writeManifest(verdictFile, [reviewedA, reviewedB], dir);

    const result = verifyManifest({ verdictFile });

    assert.strictEqual(result.file_status, "ok",
      `normal same-dir file must still be ok after realpath fix, got "${result.file_status}"`);
    assert.strictEqual(result.verdict_status, "ok");
    assert.deepStrictEqual(result.drifted_files, []);
    assert.strictEqual(result.verdict_drift, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FR-FORGE-001 R5: verdict_file symlink escape (asymmetric fix gap) ──
// Bug: R4 added realpathSync containment for files[] but NOT for the verdict file itself.
// A verdict.json that is a SYMLINK to an outside file will be read (readFileSync follows
// symlinks), and the manifest's verdict_binding.hash can match the OUTSIDE content's hash,
// yielding verdict_status:"ok" while the verdict content was actually read from outside
// repoRoot. Fix: symmetric realpath containment for verdictFile, same as files[].
test("(R5-verdict-symlink) verdict_file symlink escape → verdict_status:drift, NOT ok", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "vsm-vsym-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "vsm-vsym-out-"));
  try {
    // Create a real reviewed file inside repoDir
    const reviewedFile = join(repoDir, "real-file.md");
    const reviewedContent = "legitimate reviewed content";
    writeFileSync(reviewedFile, reviewedContent);
    const reviewedHash = sha256(reviewedContent);

    // Create OUTSIDE verdict content
    const outsideVerdictPath = join(outsideDir, "verdict.json");
    const outsideVerdictContent = JSON.stringify({
      verdict: "pass",
      summary: "ESCAPED — this verdict lives outside repoRoot",
    });
    writeFileSync(outsideVerdictPath, outsideVerdictContent);
    const outsideVerdictHash = sha256(outsideVerdictContent);

    // verdict.json INSIDE repoDir is a SYMLINK to the outside verdict
    const verdictSymlink = join(repoDir, "verdict.json");
    symlinkSync(outsideVerdictPath, verdictSymlink);

    // Manifest: verdict_binding.hash = sha256(OUTSIDE content), verdict_file="verdict.json"
    // files[] has one legitimate in-repo file with correct hash
    const badManifest = {
      manifest_version: "1",
      hash_algorithm: "sha256",
      files: [{ path: "real-file.md", hash: reviewedHash }],
      verdict_binding: {
        verdict_id: randomUUID(),
        verdict_file: "verdict.json",
        hash: outsideVerdictHash,
      },
    };
    const manifestPath = verdictSymlink + ".snapshot-manifest";
    writeFileSync(manifestPath, JSON.stringify(badManifest, null, 2) + "\n");

    const result = verifyManifest({ verdictFile: verdictSymlink });

    // Must NOT return ok — verdict_file symlink escapes repoRoot
    assert.strictEqual(
      result.verdict_status,
      "drift",
      `verdict_file symlink escape must return verdict_status:drift, got "${result.verdict_status}"`
    );
    assert.strictEqual(
      result.verdict_drift,
      true,
      "verdict_drift must be true for escaped verdict symlink"
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ── Summary ──
console.log(`\nverify-snapshot-manifest.test.mjs: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
