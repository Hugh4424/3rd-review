#!/usr/bin/env node
// build-review-package.test.mjs — T009 regression for the machine-generated review package.
//
// Phase 2 hand-assembled a 1296-line bash review package; the worktree inventory
// stats (statusLineCount / uniquePathCount / rename old-new expansion) were
// error-prone to hand-count. This generator owns those facts so the main agent
// never hand-counts them again.
//
// Asserts (RD-6 main-reviewer cost reduction; user-authorized package generator):
//   - buildWorktreeInventory parses `git status --porcelain=v1` into structured rows
//   - rename (R) rows expand into BOTH old and new path (renameOldNewCount)
//   - stats are exact: statusLineCount / uniquePathCount / renameOldNewCount /
//     untrackedCount / deletedCount
//   - each row carries status + path (classification/reason default to unclassified)
//   - markdown render includes the machine stats line + every active path verbatim
import { buildWorktreeInventory, renderInventoryMarkdown, gatherChangedContent } from "./build-review-package.mjs";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fail++; console.error(`  [FAIL] ${name} — ${e.message}`); }
}

// porcelain=v1 sample: modified, added, deleted, untracked, and a rename.
const PORCELAIN = [
  " M packages/core/agenthub/harness/review-dispatch-adapter.sh",
  "A  packages/core/agenthub/skills/3rd-review/standalone.sh",
  " D packages/core/agenthub/old-file.sh",
  "?? packages/core/agenthub/schemas/standalone-output.schema.json",
  "R  old/path.ts -> new/path.ts",
].join("\n");

test("parses porcelain into one row per status line", () => {
  const inv = buildWorktreeInventory(PORCELAIN);
  assert.equal(inv.stats.statusLineCount, 5, `statusLineCount=${inv.stats.statusLineCount}`);
});

test("rename expands into both old and new path", () => {
  const inv = buildWorktreeInventory(PORCELAIN);
  const paths = inv.rows.map((r) => r.path);
  assert.ok(paths.includes("old/path.ts"), "old rename path missing");
  assert.ok(paths.includes("new/path.ts"), "new rename path missing");
  assert.equal(inv.stats.renameOldNewCount, 2, `renameOldNewCount=${inv.stats.renameOldNewCount}`);
});

test("uniquePathCount counts distinct paths including both rename ends", () => {
  const inv = buildWorktreeInventory(PORCELAIN);
  // 4 plain paths + 2 rename ends = 6 distinct paths
  assert.equal(inv.stats.uniquePathCount, 6, `uniquePathCount=${inv.stats.uniquePathCount}`);
});

test("untrackedCount and deletedCount are exact", () => {
  const inv = buildWorktreeInventory(PORCELAIN);
  assert.equal(inv.stats.untrackedCount, 1, `untrackedCount=${inv.stats.untrackedCount}`);
  assert.equal(inv.stats.deletedCount, 1, `deletedCount=${inv.stats.deletedCount}`);
});

test("each row carries status + path + classification + reason fields", () => {
  const inv = buildWorktreeInventory(PORCELAIN);
  for (const row of inv.rows) {
    assert.ok(typeof row.status === "string" && row.status.length > 0, "missing status");
    assert.ok(typeof row.path === "string" && row.path.length > 0, "missing path");
    assert.ok("classification" in row, "missing classification field");
    assert.ok("reason" in row, "missing reason field");
  }
});

test("empty porcelain yields zero stats, no rows", () => {
  const inv = buildWorktreeInventory("");
  assert.equal(inv.stats.statusLineCount, 0);
  assert.equal(inv.rows.length, 0);
});

test("markdown render includes the machine stats line and every active path", () => {
  const inv = buildWorktreeInventory(PORCELAIN);
  const md = renderInventoryMarkdown(inv);
  assert.ok(/statusLineCount/.test(md), "stats line missing statusLineCount");
  assert.ok(/uniquePathCount/.test(md), "stats line missing uniquePathCount");
  for (const p of ["packages/core/agenthub/harness/review-dispatch-adapter.sh", "old/path.ts", "new/path.ts"]) {
    assert.ok(md.includes(p), `markdown missing path ${p}`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// T010 (FR-REVMAIN-002): untracked file size cap in gatherChangedContent
// Large untracked files must be truncated + marked; small ones pass through whole.
// ─────────────────────────────────────────────────────────────────────

test("T010-A: large untracked file is capped and truncation marker is present", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brp-t010-large-"));
  try {
    // Write a file that exceeds UNTRACKED_MAX_BYTES (32768 bytes)
    const largeContent = "x".repeat(40000);
    fs.writeFileSync(path.join(tmpDir, "big.ts"), largeContent, "utf8");

    // Build a porcelain string that marks big.ts as untracked
    const porcelain = `?? big.ts`;
    const inv = buildWorktreeInventory(porcelain);
    const changed = gatherChangedContent(tmpDir, inv, null);

    const entry = changed.untracked.find((u) => u.path === "big.ts");
    assert.ok(entry, "untracked entry for big.ts must exist");
    // Body must contain the truncation marker
    assert.ok(
      entry.body.includes("[truncated:") || entry.body.includes("[truncated "),
      `body must contain truncation marker; got: ${entry.body.slice(0, 200)}`
    );
    // Body length must not exceed cap + a reasonable margin for the marker line (200 bytes)
    assert.ok(
      entry.body.length <= 32768 + 200,
      `body length ${entry.body.length} exceeds cap+margin of ${32768 + 200}`
    );
    // Must mention total size
    assert.ok(
      entry.body.includes("40000") || /\d{4,}/.test(entry.body),
      "body marker should mention the total byte count"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("T010-B: small untracked file is NOT truncated (passes through whole)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brp-t010-small-"));
  try {
    const smallContent = "hello world — small file content\n".repeat(20); // ~680 bytes
    fs.writeFileSync(path.join(tmpDir, "small.ts"), smallContent, "utf8");

    const porcelain = `?? small.ts`;
    const inv = buildWorktreeInventory(porcelain);
    const changed = gatherChangedContent(tmpDir, inv, null);

    const entry = changed.untracked.find((u) => u.path === "small.ts");
    assert.ok(entry, "untracked entry for small.ts must exist");
    assert.ok(
      !entry.body.includes("[truncated:") && !entry.body.includes("[truncated "),
      "small file body must NOT contain truncation marker"
    );
    assert.equal(entry.body, smallContent, "small file body must equal full content");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────
// T010-C (FR-REVMAIN-002 byte-accurate): multibyte UTF-8 file whose CHAR count
// is below the cap but whose UTF-8 BYTE count exceeds it must be truncated.
// 12000 CJK chars × 3 bytes/char = 36000 UTF-8 bytes > 32768 cap.
// char count 12000 < 32768 — the old char-based guard would NOT truncate this.
// ─────────────────────────────────────────────────────────────────────
test("T010-C: multibyte UTF-8 file exceeding byte cap but not char cap is truncated with byte-accurate marker", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brp-t010c-cjk-"));
  try {
    // Each CJK char (U+4E00) is 3 UTF-8 bytes.
    // 12000 chars → 36000 bytes > 32768 cap; 12000 chars < 32768 cap → old code passes through whole.
    const cjkChar = "一"; // 一
    const cjkContent = cjkChar.repeat(12000);
    const totalBytes = Buffer.byteLength(cjkContent, "utf8"); // 36000
    assert.equal(totalBytes, 36000, `sanity: totalBytes=${totalBytes}`);
    assert.ok(cjkContent.length < 32768, `sanity: charCount=${cjkContent.length} should be <32768`);

    fs.writeFileSync(path.join(tmpDir, "cjk.md"), cjkContent, "utf8");

    const porcelain = `?? cjk.md`;
    const inv = buildWorktreeInventory(porcelain);
    const changed = gatherChangedContent(tmpDir, inv, null);

    const entry = changed.untracked.find((u) => u.path === "cjk.md");
    assert.ok(entry, "untracked entry for cjk.md must exist");

    // (a) body IS truncated — must contain the truncation marker
    assert.ok(
      entry.body.includes("[truncated:"),
      `body must contain truncation marker; got: ${entry.body.slice(0, 200)}`
    );

    // (b) resulting body's UTF-8 byte length must be ≤ UNTRACKED_MAX_BYTES (32768)
    const bodyBytes = Buffer.byteLength(entry.body, "utf8");
    // The kept content part (before the marker) must be ≤ cap; the marker itself adds a small overhead.
    // Extract the part before the marker and verify it fits.
    const markerIdx = entry.body.indexOf("\n\n[truncated:");
    assert.ok(markerIdx >= 0, "marker separator must be present");
    const keptPart = entry.body.slice(0, markerIdx);
    const keptBytes = Buffer.byteLength(keptPart, "utf8");
    assert.ok(
      keptBytes <= 32768,
      `kept content UTF-8 bytes (${keptBytes}) must be ≤ 32768 (UNTRACKED_MAX_BYTES)`
    );

    // (c) truncation marker must report byte totals matching Buffer.byteLength
    // Expect the marker to contain the total byte count (36000)
    assert.ok(
      entry.body.includes("36000"),
      `marker must report total byte count 36000; body tail: ${entry.body.slice(-200)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nbuild-review-package.test: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
