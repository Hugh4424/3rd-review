#!/usr/bin/env node
// verdict-core-hash.test.mjs — FR-REVIEW-012: nonce + hash verification tests
//
// Tests:
//   1. same input → same hash (determinism)
//   2. field order change → same hash (canonicalization)
//   3. changed verdict → different hash
//   4. changed recommendation → different hash
//   5. extra whitespace in JSON file → same hash
//   6. _execNonce excluded from hash
//   7. _runtimeConfig excluded from hash

import { execSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert";

const SCRIPT = new URL("verdict-core-hash.mjs", import.meta.url).pathname;

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

/**
 * Minimal valid review report for hash testing.
 */
function simpleReport() {
  return {
    reviewRequestId: "test-rid",
    round: 1,
    checkpoint: "code-review-phase-6c",
    reviewMode: "delegated-code",
    verdict: "pass",
    summary: "all good",
  };
}

/**
 * Run the hash script on a JSON object (serialised to a temp file).
 * Returns the trimmed stdout (hex hash).
 */
function runHash(obj) {
  const dir = mkdtempSync(join(tmpdir(), "vch-test-"));
  const fp = join(dir, "result.json");
  try {
    writeFileSync(fp, JSON.stringify(obj));
    const out = execSync(
      `node ${JSON.stringify(SCRIPT)} --result-file=${JSON.stringify(fp)}`,
      { encoding: "utf-8" },
    ).trim();
    return out;
  } finally {
    try {
      unlinkSync(fp);
    } catch {}
    try {
      rmdirSync(dir);
    } catch {}
  }
}

/**
 * Run the hash script on a JSON file with the given content string.
 * Useful for testing pretty-printed vs compact JSON.
 */
function runHashFromContent(jsonContent) {
  const dir = mkdtempSync(join(tmpdir(), "vch-test-"));
  const fp = join(dir, "result.json");
  try {
    writeFileSync(fp, jsonContent);
    const out = execSync(
      `node ${JSON.stringify(SCRIPT)} --result-file=${JSON.stringify(fp)}`,
      { encoding: "utf-8" },
    ).trim();
    return out;
  } finally {
    try {
      unlinkSync(fp);
    } catch {}
    try {
      rmdirSync(dir);
    } catch {}
  }
}

// ── Tests ──

test("same input → same hash", () => {
  const obj = {
    reviewRequestId: "req-abc-111",
    verdict: "pass",
    findings: [{ severity: "minor", issue: "typo in comment" }],
  };
  const h1 = runHash(obj);
  const h2 = runHash(obj);
  assert.strictEqual(h1, h2);
});

test("field order change → same hash (canonicalization)", () => {
  const a = runHash({
    verdict: "pass",
    reviewRequestId: "req-1",
    summary: "ok",
  });
  const b = runHash({
    reviewRequestId: "req-1",
    summary: "ok",
    verdict: "pass",
  });
  assert.strictEqual(a, b);
});

test("changed verdict → different hash", () => {
  const a = runHash({ reviewRequestId: "req-1", verdict: "pass" });
  const b = runHash({
    reviewRequestId: "req-1",
    verdict: "revise_required",
  });
  assert.notStrictEqual(a, b);
});

test("changed recommendation → different hash", () => {
  const base = {
    reviewRequestId: "req-1",
    verdict: "pass",
    findings: [
      { severity: "minor", issue: "x", recommendation: "fix it" },
    ],
  };
  const altered = {
    ...base,
    findings: [
      { severity: "minor", issue: "x", recommendation: "ignore it" },
    ],
  };
  assert.notStrictEqual(runHash(base), runHash(altered));
});

test("changed finding file → different hash", () => {
  const base = { ...simpleReport(), findings: [{ severity: "blocking", issue: "bug", file: "a.ts", line: 42, impact: "crash" }] };
  const altered = { ...base, findings: [{ severity: "blocking", issue: "bug", file: "b.ts", line: 42, impact: "crash" }] };
  assert.notStrictEqual(runHash(base), runHash(altered));
});

test("changed finding line → different hash", () => {
  const base = { ...simpleReport(), findings: [{ severity: "blocking", issue: "bug", file: "a.ts", line: 42, impact: "crash" }] };
  const altered = { ...base, findings: [{ severity: "blocking", issue: "bug", file: "a.ts", line: 99, impact: "crash" }] };
  assert.notStrictEqual(runHash(base), runHash(altered));
});

test("changed finding impact → different hash", () => {
  const base = { ...simpleReport(), findings: [{ severity: "blocking", issue: "bug", file: "a.ts", line: 42, impact: "crash" }] };
  const altered = { ...base, findings: [{ severity: "blocking", issue: "bug", file: "a.ts", line: 42, impact: "cosmetic" }] };
  assert.notStrictEqual(runHash(base), runHash(altered));
});

test("extra whitespace in JSON file → same hash", () => {
  const obj = {
    reviewRequestId: "req-1",
    verdict: "pass",
    summary: "good",
  };
  const pretty = JSON.stringify(obj, null, 2);
  const compact = JSON.stringify(obj);
  assert.strictEqual(runHashFromContent(pretty), runHashFromContent(compact));
});

test("_execNonce excluded from hash", () => {
  const base = { reviewRequestId: "req-1", verdict: "pass" };
  const withNonce = {
    reviewRequestId: "req-1",
    verdict: "pass",
    _execNonce: "should-not-affect",
  };
  assert.strictEqual(runHash(base), runHash(withNonce));
});

test("_runtimeConfig excluded from hash", () => {
  const base = { reviewRequestId: "req-1", verdict: "pass" };
  const withConfig = {
    reviewRequestId: "req-1",
    verdict: "pass",
    _runtimeConfig: { provider: "codex" },
  };
  assert.strictEqual(runHash(base), runHash(withConfig));
});

test("subreviewerRuntimeReports excluded from hash", () => {
  const base = { reviewRequestId: "req-1", verdict: "pass" };
  const withSub = {
    reviewRequestId: "req-1",
    verdict: "pass",
    subreviewerRuntimeReports: [{ name: "lens-a" }],
  };
  assert.strictEqual(runHash(base), runHash(withSub));
});

test("delegatedReviewBundle excluded from hash", () => {
  const base = { reviewRequestId: "req-1", verdict: "pass" };
  const withBundle = {
    reviewRequestId: "req-1",
    verdict: "pass",
    delegatedReviewBundle: { lenses: [] },
  };
  assert.strictEqual(runHash(base), runHash(withBundle));
});

test("worktreeInventory excluded from hash", () => {
  const base = { reviewRequestId: "req-1", verdict: "pass" };
  const withInventory = {
    reviewRequestId: "req-1",
    verdict: "pass",
    worktreeInventory: { included: [] },
  };
  assert.strictEqual(runHash(base), runHash(withInventory));
});

test("riskDisposition excluded from hash", () => {
  const base = { reviewRequestId: "req-1", verdict: "pass" };
  const withRisk = {
    reviewRequestId: "req-1",
    verdict: "pass",
    riskDisposition: [{ risk: "high" }],
  };
  assert.strictEqual(runHash(base), runHash(withRisk));
});

test("output is 64-char hex (full sha256)", () => {
  const hash = runHash({ reviewRequestId: "req-1", verdict: "pass" });
  assert.match(hash, /^[0-9a-f]{64}$/);
});

// ── DEG R2 fix: precheckDecisionSource / routeLevel must be hash-bound ──
// These are the tamper-evidence teeth (round-4 R4-1): a tamperer must not be able
// to relabel a manual `--delegated-precheck=off` (source=explicit) as route-driven
// (source=route) to unlock the lightweight-review exemption without breaking the
// nonce/hash chain. Mutation: remove these keys from SEMANTIC_KEYS → hash unchanged
// → these tests go RED. Proves the keys are bound.

test("flipping precheckDecisionSource changes hash (tamper-bound)", () => {
  const route = {
    reviewRequestId: "req-1",
    verdict: "pass",
    reviewMode: "lightweight-review",
    precheckDecisionSource: "route",
    routeLevel: "cross_source_no_subagent",
  };
  const explicit = { ...route, precheckDecisionSource: "explicit" };
  assert.notStrictEqual(runHash(route), runHash(explicit));
});

test("flipping routeLevel changes hash (tamper-bound)", () => {
  const base = {
    reviewRequestId: "req-1",
    verdict: "pass",
    reviewMode: "lightweight-review",
    precheckDecisionSource: "route",
    routeLevel: "cross_source_no_subagent",
  };
  const altered = { ...base, routeLevel: "same_source_no_subagent" };
  assert.notStrictEqual(runHash(base), runHash(altered));
});

// ── Summary ──
console.log(`\nverdict-core-hash.test.mjs: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
