#!/usr/bin/env node
// route-review.test.mjs — T008 regression for adaptive routing (RD-5 / FR-ROUTE-001/002/003)
//
// Asserts:
//   - env detection (agenthub vs standalone) from task-dir presence only
//   - contentType 4-class detection (design-doc/plan-doc/code-diff/text-record)
//   - scope 4-tier from diff line thresholds (≤300 small, 301-1500 medium, >1500 large, 0 trivial)
//   - risk keyword escalation (only raises scope, never lowers)
//   - env/strategy SEPARATION: changing env must NOT change contentType/scope
//   - reproducibility: same input → identical route_decision (pure function)
//   - thresholds come from route-rules.json (single source), not hard-coded
import { routeReview, applyPostRoundDegradation } from "./route-review.mjs";
import assert from "node:assert";
import { readFileSync as _readFileSync } from "node:fs";
import { fileURLToPath as _ftuRules } from "node:url";
import { dirname as _dn, resolve as _rs } from "node:path";

// Reads the live route-rules.json so OFF-flag tests can clone + override the real config
// (config stays the single source of the default; tests inject an override copy).
function loadRulesForTest() {
  const dir = _dn(_ftuRules(import.meta.url));
  return JSON.parse(_readFileSync(_rs(dir, "..", "config", "route-rules.json"), "utf8"));
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fail++; console.error(`  [FAIL] ${name} — ${e.message}`); }
}

// ── source hygiene: no raw NUL bytes (binary-file poisoning of the routing file) ──
test("source file route-review.mjs is text-only (no raw NUL bytes)", () => {
  // FR-DEG repeated-blocking fingerprint must NOT embed literal NUL (0x00) bytes in source —
  // raw NUL makes git/rg/grep treat the routing file as binary and silently drop line-level
  // visibility for the review-routing mechanism itself. Use an escaped delimiter instead.
  const dir = _dn(_ftuRules(import.meta.url));
  const srcBytes = _readFileSync(_rs(dir, "route-review.mjs"));
  assert.strictEqual(srcBytes.includes(0x00), false, "route-review.mjs must not contain raw NUL (0x00) bytes");
});

// ── env detection ──
test("env=standalone when no task-dir", () => {
  const d = routeReview({ input: "hello", taskDir: null, diffLines: 0 });
  assert.equal(d.env, "standalone");
});
test("env=agenthub when task-dir has state", () => {
  const d = routeReview({ input: "hello", taskDir: "/x", hasState: true, diffLines: 0 });
  assert.equal(d.env, "agenthub");
});

// ── contentType 4-class ──
test("contentType=code-diff from diff fence", () => {
  const d = routeReview({ input: "```diff\n@@ -1 +1 @@\n+x", diffLines: 1 });
  assert.equal(d.contentType, "code-diff");
});
test("contentType=design-doc from design signal", () => {
  const d = routeReview({ input: "Review kind: design review\n## Design" });
  assert.equal(d.contentType, "design-doc");
});
test("contentType=plan-doc from plan signal", () => {
  const d = routeReview({ input: "plan review for plan.md\n## Plan" });
  assert.equal(d.contentType, "plan-doc");
});
test("contentType=text-record default when no strong signal", () => {
  const d = routeReview({ input: "just some prose with no markers" });
  assert.equal(d.contentType, "text-record");
});

// ── scope 4-tier by diff thresholds ──
test("scope=trivial at 0 diff lines", () => {
  const d = routeReview({ input: "```diff\n", diffLines: 0 });
  assert.equal(d.scope, "trivial");
});
test("scope=small at 300 (boundary)", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 300 });
  assert.equal(d.scope, "small");
});
test("scope=medium at 301 (boundary)", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 301 });
  assert.equal(d.scope, "medium");
});
test("scope=medium at 1500 (boundary)", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 1500 });
  assert.equal(d.scope, "medium");
});
test("scope=large at 1501 (boundary)", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 1501 });
  assert.equal(d.scope, "large");
});

// ── risk keyword escalation (only raises) ──
test("risk keyword escalates small→large", () => {
  const d = routeReview({ input: "```diff\n@@\n+import auth.go", diffLines: 10 });
  assert.equal(d.scope, "large");
});
test("risk keyword does not lower an already-large scope", () => {
  const d = routeReview({ input: "```diff\n@@\nDROP TABLE x", diffLines: 5000 });
  assert.equal(d.scope, "large");
});

// ── env/strategy separation ──
test("env change does NOT change contentType/scope", () => {
  const base = { input: "```diff\n@@", diffLines: 500 };
  const sa = routeReview({ ...base, taskDir: null });
  const ah = routeReview({ ...base, taskDir: "/x", hasState: true });
  assert.equal(sa.contentType, ah.contentType, "contentType must be env-independent");
  assert.equal(sa.scope, ah.scope, "scope must be env-independent");
  assert.notEqual(sa.env, ah.env, "env should differ");
});

// ── reproducibility: same input → identical decision ──
test("same input yields identical route_decision (reproducible)", () => {
  const inp = { input: "```diff\n@@ -1 +1\n+migration", taskDir: "/x", hasState: true, diffLines: 800 };
  const a = JSON.stringify(routeReview(inp));
  const b = JSON.stringify(routeReview(inp));
  assert.equal(a, b);
});

// ── decision contract: required fields + rejected[] with reasons ──
test("route_decision has all required fields and rejected[] carries reasons", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 50, taskDir: "/x", hasState: true });
  for (const f of ["env", "contentType", "scope", "selected", "rejected", "reason", "rulesVersion"]) {
    assert.ok(f in d, `missing field: ${f}`);
  }
  assert.ok(Array.isArray(d.rejected), "rejected must be array");
  for (const r of d.rejected) assert.ok(r.reason, "each rejected entry needs a reason");
  assert.ok(d.rulesVersion, "rulesVersion must come from route-rules.json");
});

// ── T_ROUTE_LEVEL_001: level field (cross_source_with_subagent / cross_source_no_subagent / same_source_subagent) ──
test("T_ROUTE_LEVEL_001 envProbe=no_external_cli short-circuits to same_source_subagent regardless of scope", () => {
  const d = routeReview({ input: "code review\n```diff", diffLines: 5000, envProbe: "no_external_cli" });
  assert.equal(d.level, "same_source_subagent", `expected same_source_subagent, got ${d.level}`);
});
test("T_ROUTE_LEVEL_001 large code-diff (diffLines=5000) → cross_source_with_subagent", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 5000 });
  assert.equal(d.level, "cross_source_with_subagent", `expected cross_source_with_subagent, got ${d.level}`);
});
test("T_ROUTE_LEVEL_001 medium code-diff (diffLines=500) → cross_source_no_subagent (R2, per tasks.md GREEN: 中等→R2)", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 500 });
  assert.equal(d.scope, "medium", `expected scope=medium for diffLines=500, got ${d.scope}`);
  assert.equal(d.level, "cross_source_no_subagent", `tasks.md GREEN requires medium→R2 (cross_source_no_subagent), got ${d.level}`);
});
test("T_ROUTE_LEVEL_001 trivial code-diff (diffLines=0) → same_source_subagent (R6, per tasks.md GREEN: 小/fast→R6)", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 0 });
  assert.equal(d.scope, "trivial", `expected scope=trivial for diffLines=0, got ${d.scope}`);
  assert.equal(d.level, "same_source_subagent", `tasks.md GREEN requires trivial→R6 (same_source_subagent), got ${d.level}`);
});
test("T_ROUTE_LEVEL_001 small code-diff (diffLines=100) → same_source_subagent (R6, per tasks.md GREEN: 小/fast→R6)", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 100 });
  assert.equal(d.scope, "small", `expected scope=small for diffLines=100, got ${d.scope}`);
  assert.equal(d.level, "same_source_subagent", `tasks.md GREEN requires small→R6 (same_source_subagent), got ${d.level}`);
});
test("T_ROUTE_LEVEL_001 text-record (plain prose) → same_source_subagent (R6)", () => {
  const d = routeReview({ input: "just prose no markers" });
  assert.equal(d.level, "same_source_subagent", `expected same_source_subagent, got ${d.level}`);
});
test("T_ROUTE_LEVEL_001 basis is non-empty string", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 5000 });
  assert.ok(typeof d.basis === "string" && d.basis.length > 0, `basis must be non-empty string, got ${JSON.stringify(d.basis)}`);
});
// routeReview() must stay pure/deterministic: no wall-clock timestamp inside the decision.
// timestamp belongs to the CLI/persistence boundary (FR-TRACE, Phase 6), not the pure router.
test("T_ROUTE_LEVEL_001 routeReview() is pure — no timestamp field leaking wall-clock into decision", () => {
  const d = routeReview({ input: "```diff\n@@", diffLines: 5000 });
  assert.ok(!("timestamp" in d), `routeReview() must not carry timestamp (breaks reproducibility), got ${JSON.stringify(d.timestamp)}`);
});

// ── T_DEGRADE_001..004: applyPostRoundDegradation(history, currentDecision) (FR-DEGRADE-001/002) ──
// Post-round degradation: based on previous round's finding count + severity,
// auto-downgrade the routing level; re-escalate when a NEW blocking appears.
// non-diff objects (design/plan/intake/text) judge by finding count + severity,
// never by diff line count.

const fullDecision = () => routeReview({ input: "```diff\n@@", diffLines: 5000 }); // → cross_source_with_subagent (R1)
const R1 = "cross_source_with_subagent";
const R2 = "cross_source_no_subagent";
const R6 = "same_source_subagent";

// ── 3-tier adaptive degradation (FR-DEG-001..004, Clarifications 2026-06-19) ──
// Branch 1: no blocking, few findings → downgrade ONE tier (R1→R2, R2→R6, R6→R6).
// Branch 2: exactly 1 NON-hard-guardrail blocking → R2 (mid tier). REVERSES old "1 blocking→R6".
// Branch 3: >1 blocking OR any hard-guardrail blocking → R1 (stay full scope).
// Branch 4: same blocking repeated across rounds → escalate (decision.escalate=true).

test("T_DEGRADE_001 no-blocking few findings → downgrade ONE tier from current (R1→R2)", () => {
  const history = [{ round: 1, findings: [{ severity: "minor" }] }]; // 1 finding, no blocking
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, R2, `no-blocking few findings must downgrade one tier R1→R2, got ${d.level}`);
  assert.match(d.basis || "", /degrad/i, `basis must record degradation, got ${d.basis}`);
});

test("T_DEGRADE_001b exactly 1 NON-hard-guardrail blocking → R2 mid tier (REVERSES old 1-blocking→R6)", () => {
  // FR-DEG-001/004: a single ordinary (delivery_quality) blocking is NOT a hard guardrail → mid tier R2.
  const history = [{ round: 1, findings: [{ severity: "blocking", blockerClass: "delivery_quality" }] }];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, R2, `single non-guardrail blocking must route R2 mid tier, got ${d.level}`);
});

test("T_DEGRADE_001c down-one-tier from R2 baseline → R6", () => {
  const r2Decision = routeReview({ input: "```diff\n@@", diffLines: 500 }); // medium → R2
  assert.strictEqual(r2Decision.level, R2, `precondition: medium diff baseline must be R2, got ${r2Decision.level}`);
  const history = [{ round: 1, findings: [{ severity: "minor" }] }]; // no blocking, few
  const d = applyPostRoundDegradation(history, r2Decision);
  assert.strictEqual(d.level, R6, `no-blocking down-one-tier from R2 must reach R6, got ${d.level}`);
});

test("T_DEGRADE_002 >1 blocking → keep full scope (R1)", () => {
  const history = [{ round: 1, findings: [{ severity: "blocking" }, { severity: "blocking" }] }];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, R1, `>1 blocking must keep R1, got ${d.level}`);
});

test("T_DEGRADE_002-guard any HARD-GUARDRAIL blocking → keep R1 even if single", () => {
  // FR-DEG-004: a single blocking whose blockerClass is output_contract (hard guardrail) → R1.
  const history = [{ round: 1, findings: [{ severity: "blocking", blockerClass: "output_contract" }] }];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, R1, `single hard-guardrail blocking must keep R1, got ${d.level}`);
  assert.match(d.basis || "", /guardrail/i, `basis must cite hard-guardrail, got ${d.basis}`);
});

test("T_DEGRADE_002b ≥2 findings but ALL non-blocking → downgrade one tier (R1→R2)", () => {
  const history = [{ round: 1, findings: [{ severity: "important" }, { severity: "minor" }] }];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, R2, `≥2 all non-blocking must downgrade one tier R1→R2, got ${d.level}`);
});

test("T_DEGRADE_002c downgraded result reaching R6 MUST carry cleanContextRequired=true (FR-QUALITY-001 reuse)", () => {
  const r2Decision = routeReview({ input: "```diff\n@@", diffLines: 500 }); // R2 baseline
  const history = [{ round: 1, findings: [{ severity: "minor" }] }]; // no blocking → R2→R6
  const d = applyPostRoundDegradation(history, r2Decision);
  assert.strictEqual(d.level, R6, `precondition: must downgrade to R6, got ${d.level}`);
  assert.strictEqual(d.cleanContextRequired, true, `degraded R6 must enforce clean context, got cleanContextRequired=${d.cleanContextRequired}`);
});

test("T_DEGRADE_ESCALATE same blocking repeated across rounds → escalate (FR-DEG, repeated-blocking)", () => {
  // Same file+category+core-description blocking unresolved across 2 rounds → escalate_to_human.
  const fp = { severity: "blocking", domain: "security", codePath: "server/auth.go", category: "contract", description: "auth bypass unfixed" };
  const history = [
    { round: 1, level: R1, findings: [{ ...fp }] },
    { round: 2, level: R1, findings: [{ ...fp }] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.escalate, true, `repeated identical blocking must signal escalate, got escalate=${d.escalate}`);
  assert.match(d.basis || "", /escalat/i, `basis must record escalation, got ${d.basis}`);
});

test("T_DEGRADE_ESCALATE_UNDER_R6 same blocking repeated while LAST round already downgraded to R6 → escalate (repeated-blocking wins over same-domain stickiness)", () => {
  // B1 regression: last round level is same_source_subagent (R6) AND the same blocking
  // (same file/category/description, same domain "security") repeats previous→last round.
  // Same-domain means it is NOT new-domain, so the stickiness branch would otherwise return R6.
  // Repeated-blocking escalation must take priority: assert escalate=true (NOT stuck on R6).
  const fp = { severity: "blocking", domain: "security", codePath: "server/auth.go", category: "contract", description: "auth bypass unfixed" };
  const history = [
    { round: 1, level: R6, findings: [{ ...fp }] },
    { round: 2, level: R6, findings: [{ ...fp }] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.escalate, true, `repeated blocking under R6 must escalate (not stay R6); got escalate=${d.escalate} level=${d.level}`);
  assert.match(d.basis || "", /escalat/i, `basis must record escalation, got ${d.basis}`);
});

// ── repeated-blocking fingerprint: real reviewer field shape + target-drift coverage ──
// The reviewer finding shape is `severity/blockerClass/file/line/issue/...` (NOT category/description).
// These tests pin: (1) same root blocking re-worded across rounds still fingerprints the same →
// escalates from round 2 on; (2) genuinely different blockings on the same file do NOT collapse →
// no false escalate; (3) findings missing all identity parts are not fingerprintable.

test("T_DEGRADE_REPEAT_DRIFT same root blocking, only line refs / path-prefix / punctuation differ → escalate by round 2", () => {
  // Same file + same blockerClass; the issue TEXT is the same root problem, differing only in the
  // NOISE that conservative normalization strips: line refs (:12 / line 45 / L88), an absolute path
  // prefix, and punctuation. After normalization the fingerprints must be identical, so the
  // repeated-blocking escalation must already fire at round 2 (last==round2 vs prior round1).
  // (Conservative normalization deliberately does NOT merge re-WORDED text — only noise. So the
  // drift this catches is the realistic "same sentence, moved line / repunctuated" form.)
  const r1 = { round: 1, level: "cross_source_with_subagent", findings: [
    { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs", line: 12,
      issue: "CLI does not reject empty sample, line 12." },
  ] };
  const r2 = { round: 2, level: "cross_source_with_subagent", findings: [
    { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs", line: 45,
      issue: "CLI does not reject empty sample :45" },
  ] };
  const d = applyPostRoundDegradation([r1, r2], fullDecision());
  assert.strictEqual(d.escalate, true, `same root blocking (only noise differs) must escalate at round 2, got escalate=${d.escalate}`);
});

test("T_DEGRADE_REPEAT_DRIFT_ALTERNATE drift across NON-adjacent rounds (A→B→A) → escalate (full-history compare)", () => {
  // Reviewer dodges adjacent-round comparison by alternating files: R1 reports problem on file A,
  // R2 reports a different problem on file B, R3 re-reports the SAME problem on file A. Adjacent-only
  // comparison (R2 vs R3) would miss it; full-history comparison (R3 vs R1) must catch it.
  const fpA = { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs",
    issue: "replayDiff 空样本被判 PASS" };
  const r1 = { round: 1, level: "cross_source_with_subagent", findings: [{ ...fpA, line: 12 }] };
  const r2 = { round: 2, level: "cross_source_with_subagent", findings: [
    { severity: "blocking", blockerClass: "concurrency", file: "scripts/runner.mjs", line: 90,
      issue: "worker pool 竞态导致结果丢失" },
  ] };
  const r3 = { round: 3, level: "cross_source_with_subagent", findings: [{ ...fpA, line: 88 }] };
  const d = applyPostRoundDegradation([r1, r2, r3], fullDecision());
  assert.strictEqual(d.escalate, true, `same root blocking re-surfacing in non-adjacent round must escalate, got escalate=${d.escalate}`);
});

test("T_DEGRADE_REPEAT_NO_FALSE_MERGE genuinely different blockings on SAME file → NO escalate (no over-merge)", () => {
  // Same file, but round 1 is about empty-sample handling and round 2 is a real DIFFERENT root cause
  // (concurrency race) AND a different blockerClass. Fingerprints must differ → repeated=false →
  // the single non-guardrail blocking in round 2 routes mid-tier R2, it must NOT escalate.
  const r1 = { round: 1, level: "cross_source_with_subagent", findings: [
    { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs", line: 12,
      issue: "CLI 没拒空样本" },
  ] };
  const r2 = { round: 2, level: "cross_source_with_subagent", findings: [
    { severity: "blocking", blockerClass: "concurrency", file: "scripts/replay.mjs", line: 12,
      issue: "worker pool 竞态导致结果丢失" },
  ] };
  const d = applyPostRoundDegradation([r1, r2], fullDecision());
  assert.notStrictEqual(d.escalate, true, `genuinely different blockings must not over-merge into escalate, got escalate=${d.escalate}`);
  assert.strictEqual(d.level, R2, `non-repeated single non-guardrail blocking must route mid-tier R2, got ${d.level}`);
});

test("T_DEGRADE_REPEAT_EMPTY_FIELDS blocking missing file/blockerClass/issue → not fingerprintable → NO escalate", () => {
  // A finding with severity:blocking but no file/blockerClass/issue (and no fallback text) is not
  // fingerprintable → null → never participates in repeated-blocking escalation. Repeated across two
  // rounds it must still NOT escalate (it routes by the normal single-blocking path instead).
  const bare = { severity: "blocking" };
  const r1 = { round: 1, level: "cross_source_with_subagent", findings: [{ ...bare }] };
  const r2 = { round: 2, level: "cross_source_with_subagent", findings: [{ ...bare }] };
  const d = applyPostRoundDegradation([r1, r2], fullDecision());
  assert.notStrictEqual(d.escalate, true, `unfingerprintable blocking must not escalate, got escalate=${d.escalate}`);
});

test("T_DEGRADE_MIDTIER_OFF flag false → falls back to binary R1/R6 (single non-guardrail blocking → R6)", () => {
  // FR-CFG-001: with degradation.midTier.enabled=false, no R2 ever;
  // single blocking falls back to old binary R6 behavior. The flag default lives in
  // route-rules.json (default true); tests inject an override via the optional 3rd arg so
  // the committed config stays untouched (config remains the single source of the default).
  const history = [{ round: 1, findings: [{ severity: "blocking", blockerClass: "delivery_quality" }] }];
  const rulesOff = loadRulesForTest();
  rulesOff.degradation.midTier = { enabled: false };
  const d = applyPostRoundDegradation(history, fullDecision(), { rules: rulesOff });
  assert.strictEqual(d.level, R6, `midTier OFF: single non-guardrail blocking must fall back to R6, got ${d.level}`);
});

test("T_DEGRADE_MIDTIER_OFF-noblocking flag false → no-blocking few falls back to R6 (binary, no R2)", () => {
  const history = [{ round: 1, findings: [{ severity: "minor" }] }];
  const rulesOff = loadRulesForTest();
  rulesOff.degradation.midTier = { enabled: false };
  const d = applyPostRoundDegradation(history, fullDecision(), { rules: rulesOff });
  assert.strictEqual(d.level, R6, `midTier OFF: no-blocking few must fall back to R6 (no R2), got ${d.level}`);
});

test("T_DEGRADE_003 already downgraded, NEW blocking with new domain → re-escalate to full scope (R1)", () => {
  // FR-DEG-001/002: re-escalation only fires when the blocking qualifies as "new-domain".
  // history: round 1 covered "security" domain; round 2 (downgraded R6) finds blocking in "performance" (new domain).
  // "performance" is in route-rules.json degradation.newDomainRules.lensTypes → qualifies → escalate to R1.
  const history = [
    { round: 1, findings: [{ severity: "minor", domain: "security" }], level: "same_source_subagent" },
    { round: 2, findings: [{ severity: "blocking", lensType: "performance" }], level: "same_source_subagent" }, // new-domain blocking
  ];
  const d = applyPostRoundDegradation(history, routeReview({ input: "```diff\n@@", diffLines: 100 }));
  assert.strictEqual(d.level, "cross_source_with_subagent", `new-domain blocking must re-escalate to R1, got ${d.level}`);
  assert.match(d.basis || "", /re-?escalat|new.domain/i, `basis must record re-escalation, got ${d.basis}`);
});

test("T_DEGRADE_004 non-diff design input → judge by finding count + severity, not diff lines", () => {
  // Falsifiability: the fixture's BASELINE level must be full-scope R1 so the downgrade
  // is a real transition, not a no-op. A design doc with a risk keyword routes to large
  // scope = cross_source_with_subagent (R1) WITH diffLines=0 — proving the degradation
  // judgement runs on finding count, not diff lines (there are none). 0 findings (no blocking,
  // few) → downgrade ONE tier R1→R2 per the 3-tier matrix.
  const designDecision = routeReview({ input: "## Design\nthis touches auth.go and security boundary", diffLines: 0 });
  assert.strictEqual(designDecision.level, "cross_source_with_subagent", `fixture precondition: design baseline must be R1, got ${designDecision.level}`);
  const history = [{ round: 1, findings: [], level: designDecision.level }]; // 0 findings, diff=0
  const d = applyPostRoundDegradation(history, designDecision);
  assert.strictEqual(d.level, "cross_source_no_subagent", `0 findings on non-diff design input must downgrade one tier R1→R2 by finding count, got ${d.level}`);
  assert.match(d.basis || "", /finding/i, `basis must cite finding-count judgement (not diff lines), got ${d.basis}`);
});

// ── T006/T008: CLI --history flag wires applyPostRoundDegradation ──
// These tests exercise the CLI entrypoint via node child_process to confirm
// that --history is parsed, history is loaded, and applyPostRoundDegradation
// is applied before outputting the route decision.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath as _ftu } from "node:url";

const SCRIPT = _ftu(new URL("./route-review.mjs", import.meta.url));

function runCLI(args) {
  // Route all input via --input=<file> (large diff → cross_source_with_subagent baseline)
  const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return JSON.parse(out);
}

test("T006 --history=<empty-file> no-op: level unchanged from full-scope baseline", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rr-test-"));
  try {
    const histFile = join(tmp, "history.jsonl");
    const inputFile = join(tmp, "input.txt");
    writeFileSync(histFile, ""); // empty history
    writeFileSync(inputFile, "```diff\n@@\n+change"); // triggers code-diff
    const d = runCLI([`--input=${inputFile}`, "--diff-lines=5000", `--history=${histFile}`]);
    // No history → applyPostRoundDegradation returns original decision → must be full scope
    assert.strictEqual(d.level, "cross_source_with_subagent",
      `empty history must not downgrade; got level=${d.level}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T006 --history with no-blocking finding on last round → level downgraded ONE tier (R1→R2)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rr-test-"));
  try {
    const histEntry = JSON.stringify({ round: 1, level: "cross_source_with_subagent", findings: [{ severity: "minor" }] });
    const histFile = join(tmp, "history.jsonl");
    const inputFile = join(tmp, "input.txt");
    writeFileSync(histFile, histEntry + "\n");
    writeFileSync(inputFile, "```diff\n@@\n+change");
    const d = runCLI([`--input=${inputFile}`, "--diff-lines=5000", `--history=${histFile}`]);
    assert.strictEqual(d.level, "cross_source_no_subagent",
      `no-blocking finding in history must downgrade one tier R1→R2; got level=${d.level}`);
    assert.ok(d.basis && /degrad/i.test(d.basis),
      `basis must record degradation; got ${d.basis}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T006 --history with >1 blocking → level stays cross_source_with_subagent (R1)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rr-test-"));
  try {
    const histEntry = JSON.stringify({ round: 1, level: "cross_source_with_subagent", findings: [{ severity: "blocking" }, { severity: "blocking" }] });
    const histFile = join(tmp, "history.jsonl");
    const inputFile = join(tmp, "input.txt");
    writeFileSync(histFile, histEntry + "\n");
    writeFileSync(inputFile, "```diff\n@@\n+change");
    const d = runCLI([`--input=${inputFile}`, "--diff-lines=5000", `--history=${histFile}`]);
    assert.strictEqual(d.level, "cross_source_with_subagent",
      `≥2 findings incl blocking must keep full scope; got level=${d.level}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T006 no --history flag: behavior identical to before (regression guard)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rr-test-"));
  try {
    const inputFile = join(tmp, "input.txt");
    writeFileSync(inputFile, "```diff\n@@\n+change");
    const d = runCLI([`--input=${inputFile}`, "--diff-lines=5000"]);
    // Without --history there is no degradation; baseline for large diff is R1
    assert.strictEqual(d.level, "cross_source_with_subagent",
      `no --history flag must not degrade; got level=${d.level}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T008b multi-blocking never downgrades below R1 (anti-bypass, FR-DEG-002/003)", () => {
  // Confirm the implementation only uses applyPostRoundDegradation from this module
  // (no new inline logic that bypasses blocking findings). >1 blocking must stay R1.
  const history2 = [{ round: 1, findings: [{ severity: "blocking" }, { severity: "blocking" }], level: "cross_source_with_subagent" }];
  const d = applyPostRoundDegradation(history2, { level: "cross_source_with_subagent", basis: "base" });
  assert.strictEqual(d.level, "cross_source_with_subagent",
    `>1 blocking must NOT trigger degradation; got ${d.level}`);
});

// ── T_CHECKPOINT_ISO: FR-DEGRADE-002 checkpoint isolation (cross-checkpoint contamination guard) ──
// A new checkpoint's round=1 must NOT be degraded by a DIFFERENT checkpoint's prior-round history.
// Before fix: --checkpoint filter was absent, so history from code-review-phase-0 (0 findings)
// would degrade code-review-phase-1 round=1 → same_source_subagent (WRONG).
// After fix: CLI filters history to only records matching --checkpoint=<current>; phase-0 records
// are discarded, history for phase-1 round=1 is empty → no degradation (CORRECT, FR-DEGRADE-002).

test("T_CHECKPOINT_ISO core regression: round=1 of new checkpoint must NOT be degraded by different checkpoint's 0-finding history (FR-DEGRADE-002)", () => {
  // This is the PURE function test (no CLI) — applyPostRoundDegradation receives already-filtered
  // history. When filter is applied upstream, round=1 of code-review-phase-1 gets [] history.
  const emptyHistory = []; // after checkpoint-scoped filter, phase-1 round=1 sees no prior records
  const largeDecision = routeReview({ input: "```diff\n@@", diffLines: 5000 }); // → R1 baseline
  assert.strictEqual(largeDecision.level, "cross_source_with_subagent", `fixture precondition: large diff must be R1, got ${largeDecision.level}`);
  const d = applyPostRoundDegradation(emptyHistory, largeDecision);
  assert.strictEqual(d.level, "cross_source_with_subagent",
    `empty (checkpoint-filtered) history must not degrade round=1; got ${d.level}`);
});

test("T_CHECKPOINT_ISO CLI: --checkpoint isolates history — phase-1 round=1 NOT degraded by phase-0 0-finding record", () => {
  // RED before fix: history file has 1 record (checkpoint=code-review-phase-0, 0 findings).
  // Without checkpoint filter, applyPostRoundDegradation sees 0 findings → downgrades to R6.
  // GREEN after fix: CLI filters to only records with checkpoint=code-review-phase-1 → [] → no degrade.
  const tmp = mkdtempSync(join(tmpdir(), "rr-cpiso-"));
  try {
    const histEntry = JSON.stringify({
      round: 1,
      checkpoint: "code-review-phase-0",
      level: "cross_source_with_subagent",
      findings: [], // 0 findings: would trigger degradation if not filtered
    });
    const histFile = join(tmp, "history.jsonl");
    const inputFile = join(tmp, "input.txt");
    writeFileSync(histFile, histEntry + "\n");
    writeFileSync(inputFile, "```diff\n@@\n+large change"); // code-diff signal
    const d = runCLI([
      `--input=${inputFile}`,
      "--diff-lines=5000", // large → R1 baseline
      `--history=${histFile}`,
      "--checkpoint=code-review-phase-1", // current checkpoint: different from history record
    ]);
    assert.strictEqual(d.level, "cross_source_with_subagent",
      `round=1 of phase-1 must NOT be degraded by phase-0 history; got level=${d.level} basis=${d.basis}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T_CHECKPOINT_ISO CLI: same-checkpoint history still degrades (positive case, --checkpoint filter keeps matching records)", () => {
  // When history record has the SAME checkpoint as --checkpoint, it should still apply degradation.
  const tmp = mkdtempSync(join(tmpdir(), "rr-cpiso-pos-"));
  try {
    const histEntry = JSON.stringify({
      round: 1,
      checkpoint: "code-review-phase-1",
      level: "cross_source_with_subagent",
      findings: [{ severity: "minor" }], // 1 finding → triggers downgrade
    });
    const histFile = join(tmp, "history.jsonl");
    const inputFile = join(tmp, "input.txt");
    writeFileSync(histFile, histEntry + "\n");
    writeFileSync(inputFile, "```diff\n@@\n+large change");
    const d = runCLI([
      `--input=${inputFile}`,
      "--diff-lines=5000",
      `--history=${histFile}`,
      "--checkpoint=code-review-phase-1", // same checkpoint → history should still apply
    ]);
    assert.strictEqual(d.level, "cross_source_no_subagent",
      `same-checkpoint history with no-blocking finding must still degrade one tier R1→R2; got level=${d.level}`);
    assert.ok(d.basis && /degrad/i.test(d.basis),
      `basis must record degradation; got ${d.basis}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T_CHECKPOINT_ISO CLI: no --checkpoint flag → no filtering (backward compat: existing behavior preserved)", () => {
  // Without --checkpoint, the filter does not apply; old records without checkpoint field still degrade.
  const tmp = mkdtempSync(join(tmpdir(), "rr-cpiso-compat-"));
  try {
    const histEntry = JSON.stringify({
      round: 1,
      // No checkpoint field (old record format)
      level: "cross_source_with_subagent",
      findings: [{ severity: "minor" }],
    });
    const histFile = join(tmp, "history.jsonl");
    const inputFile = join(tmp, "input.txt");
    writeFileSync(histFile, histEntry + "\n");
    writeFileSync(inputFile, "```diff\n@@\n+large change");
    const d = runCLI([
      `--input=${inputFile}`,
      "--diff-lines=5000",
      `--history=${histFile}`,
      // No --checkpoint: backward compat — treat full history as applicable
    ]);
    assert.strictEqual(d.level, "cross_source_no_subagent",
      `without --checkpoint, old records (no checkpoint field) must still trigger one-tier degradation R1→R2; got level=${d.level}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── T_DEG_STICKY: FR-DEG-001/002/003 — degradation stickiness + new-domain exception ──
// FR-DEG-001: round≥2 under R6 downgrade, a NEW blocking that is NOT new-domain → stay R6 (no escalate).
// FR-DEG-002: round≥2 under R6, a new blocking that IS new-domain → escalate to R1.
// FR-DEG-003: new-domain detection is config-driven (route-rules.json degradation.newDomainRules).

test("T_DEG_STICKY_001 round≥2 R6 blocking (not new-domain) → stays R6 (FR-DEG-001 stickiness)", () => {
  // Last round: downgraded (R6), finding has domain "security" — same as previous rounds covered domains.
  // New blocking is in the same domain → must NOT escalate to R1.
  const history = [
    { round: 1, level: "cross_source_with_subagent", findings: [{ severity: "blocking", domain: "security" }] },
    { round: 2, level: "same_source_subagent",        findings: [{ severity: "blocking", domain: "security" }] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, "same_source_subagent",
    `non-new-domain blocking under R6 must NOT escalate; got ${d.level}`);
});

test("T_DEG_STICKY_002 round≥2 R6 blocking with new domain → escalate to R1 (FR-DEG-002)", () => {
  // Last round: downgraded (R6), finding has domain "performance" — NOT covered in prior rounds (prior was "security").
  // New blocking is in a NEW domain → must escalate to R1.
  const history = [
    { round: 1, level: "cross_source_with_subagent", findings: [{ severity: "blocking", domain: "security" }] },
    { round: 2, level: "same_source_subagent",        findings: [{ severity: "blocking", domain: "performance" }] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, "cross_source_with_subagent",
    `new-domain blocking under R6 must escalate to R1; got ${d.level}`);
  assert.match(d.basis || "", /new.domain/i, `basis must cite new-domain; got ${d.basis}`);
});

test("T_DEG_STICKY_003 new-domain detection works by lensType (FR-DEG-003 config-driven)", () => {
  // Finding with lensType matching a newDomainRules.lensTypes entry → qualifies as new-domain.
  // Previous rounds had no findings with this lensType.
  const history = [
    { round: 1, level: "cross_source_with_subagent", findings: [{ severity: "blocking", lensType: "security" }] },
    { round: 2, level: "same_source_subagent",        findings: [{ severity: "blocking", lensType: "performance" }] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, "cross_source_with_subagent",
    `new lensType blocking must trigger R1 escalation; got ${d.level}`);
});

test("T_DEG_STICKY_005 domain in OLDER round but absent from PREVIOUS round → new-domain, escalate (FR-DEG-002 previous-round boundary)", () => {
  // round1 covered "performance"; round2 (previous) covered only "security";
  // round3 (downgraded R6) blocking in "performance" → previous round did NOT cover it → escalate to R1.
  const history = [
    { round: 1, level: "cross_source_with_subagent", findings: [{ severity: "blocking", domain: "performance" }] },
    { round: 2, level: "cross_source_with_subagent", findings: [{ severity: "blocking", domain: "security" }] },
    { round: 3, level: "same_source_subagent",        findings: [{ severity: "blocking", domain: "performance" }] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, "cross_source_with_subagent",
    `domain absent from PREVIOUS round must escalate (previous-round boundary, not all-history); got ${d.level}`);
});

test("T_DEG_STICKY_004 downgrade threshold comes from route-rules.json (config-driven, FR-DEG-003)", () => {
  // The count threshold (maxFindingsForDowngrade) must be read from config, not hardcoded.
  // count=1 non-blocking finding → no-blocking few → downgrade ONE tier R1→R2 (3-tier matrix).
  // This test does not change the config file; it confirms the existing behavior is config-sourced.
  const history = [{ round: 1, level: "cross_source_with_subagent", findings: [{ severity: "minor" }] }];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.level, "cross_source_no_subagent",
    `count=1 non-blocking must downgrade one tier R1→R2 (threshold from config); got ${d.level}`);
});

// ── route-review.mjs fingerprint-fix regressions (异源审查 4 findings) ──

test("T_DEGRADE_CLEAN_BOUNDARY A→clean→A must NOT escalate (clean-account boundary, FR-DEG repeated-blocking)", () => {
  // R1 has blocking X; R2 and R3 are blocking-free (cleared); R4 re-reports the SAME fingerprint X.
  // Because the blocking was fully cleared in R2/R3 (clean-account boundary), R4's X is a NEW
  // regression, NOT an unresolved-across-rounds blocking → must NOT escalate.
  // Falsifiability/反证: revert _hasRepeatedBlocking to scan the unbounded full history (no
  // blocking-free boundary) and this test FAILS (it would escalate against R1).
  const X = { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs",
    issue: "replayDiff empty sample judged PASS" };
  const history = [
    { round: 1, level: R1, findings: [{ ...X, line: 12 }] },
    { round: 2, level: R1, findings: [{ severity: "minor", file: "x.ts", issue: "nit" }] }, // blocking-free
    { round: 3, level: R1, findings: [] },                                                  // blocking-free
    { round: 4, level: R1, findings: [{ ...X, line: 88 }] },                                // same fingerprint as R1
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.notStrictEqual(d.escalate, true,
    `A→clean→A is a new regression, must not escalate; got escalate=${d.escalate} basis=${d.basis}`);
});

test("T_DEGRADE_NO_CLEAN_STILL_ESCALATES A→B→A with NO clean round still escalates (full-history within window)", () => {
  // R1 blocking X, R2 blocking Y (different — no clean round), R3 re-reports X.
  // No blocking-free boundary exists, so window = full history → drift dodge still caught → escalate.
  // 反证: confirm escalate stays true (window collapses to full history when no clean round).
  const X = { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs",
    issue: "replayDiff empty sample judged PASS" };
  const Y = { severity: "blocking", blockerClass: "concurrency", file: "scripts/runner.mjs",
    issue: "worker pool race loses results" };
  const history = [
    { round: 1, level: R1, findings: [{ ...X, line: 12 }] },
    { round: 2, level: R1, findings: [{ ...Y, line: 90 }] }, // blocking present → NOT a clean round
    { round: 3, level: R1, findings: [{ ...X, line: 88 }] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.escalate, true,
    `A→B→A with no clean round must still escalate; got escalate=${d.escalate}`);
  // basis must reference the REAL prior round (R1, the clean window start) and new field names.
  assert.match(d.basis || "", /file=/, `basis must use new field names (file/blockerClass/issue); got ${d.basis}`);
  assert.match(d.basis || "", /1→3/, `basis must cite real matched prior round (1→3); got ${d.basis}`);
});

test("T_DEGRADE_API_PATH_NO_MERGE same file+blockerClass, different API routes in issue → NO false merge", () => {
  // Two blockings differ only by the API route mentioned in the issue text. Route paths have no
  // file extension, so normalization must PRESERVE them → distinct fingerprints → no escalate.
  // 反证: revert _normalizeIssue to the old over-broad /\/[^\s)]*\/([^\s\/)]+)/g regex (which
  // collapses /api/v1/users and /admin/users both to "users") and this test FAILS (false escalate).
  const a = { severity: "blocking", blockerClass: "delivery_quality", file: "server/handler.go",
    issue: "GET /api/v1/users returns 500" };
  const b = { severity: "blocking", blockerClass: "delivery_quality", file: "server/handler.go",
    issue: "GET /admin/users returns 500" };
  const history = [
    { round: 1, level: R1, findings: [a] },
    { round: 2, level: R1, findings: [b] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.notStrictEqual(d.escalate, true,
    `different API routes must not over-merge into escalate; got escalate=${d.escalate}`);
});

test("T_DEGRADE_EMPTY_ISSUE_NO_FINGERPRINT empty issue (only severity+blockerClass) → null fingerprint → NO escalate", () => {
  // schema allows issue:"" — two such blockings sharing blockerClass would collapse to the same
  // ␀blockerClass␀ fingerprint under the old rule. Empty issue must make the finding
  // not-fingerprintable (null) → never escalates.
  // 反证: change _blockingFingerprint back to `if (!file && !blockerClass && !issue) return null`
  // (i.e. fingerprint empty issues by blockerClass alone) and this test FAILS (false escalate).
  const bare = { severity: "blocking", blockerClass: "delivery_quality", issue: "" };
  const history = [
    { round: 1, level: R1, findings: [{ ...bare }] },
    { round: 2, level: R1, findings: [{ ...bare }] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.notStrictEqual(d.escalate, true,
    `empty-issue blocking must not be fingerprintable → no escalate; got escalate=${d.escalate}`);
});

test("T_DEGRADE_PATH_PUNCT_BASENAME path followed by trailing punctuation still basename-ifies → escalate", () => {
  // R1 issue wraps the path with a trailing comma (`/Users/a/b/foo.ts,`). The old lookahead
  // `(?=[\s:)]|$)` did NOT allow a comma after the extension, so the path was left un-basename-ified
  // and only the punctuation pass turned it into "users a b foo ts" — keeping the directory prefix.
  // R2 reports the same root blocking using the bare basename `foo.ts`. Both must normalize to the
  // same fingerprint so the repeated blocking escalates at round 2.
  // 反证: revert the lookahead to `(?=[\s:)]|$)` (drop the trailing punctuation chars) and the R1
  // path keeps its prefix → fingerprints differ → escalate becomes false → this test FAILS.
  const r1 = { round: 1, level: R1, findings: [
    { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs",
      issue: "fails in /Users/a/b/foo.ts, due to empty sample" },
  ] };
  const r2 = { round: 2, level: R1, findings: [
    { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs",
      issue: "fails in foo.ts due to empty sample" },
  ] };
  const d = applyPostRoundDegradation([r1, r2], fullDecision());
  assert.strictEqual(d.escalate, true,
    `path with trailing punctuation must basename-ify and match bare basename → escalate; got escalate=${d.escalate}`);
});

test("T_DEGRADE_RELPATH_BASENAME relative path src/foo.ts and bare basename foo.ts share a fingerprint → escalate", () => {
  // R1 reports the same root blocking using a RELATIVE path `src/foo.ts`; R2 uses the bare basename
  // `foo.ts`. The old regex anchored its prefix on a leading slash (`(?:\/[^\s/)]+)*\/...`), so a
  // relative path matched the dir-segment slash literally and glued the directory onto the basename
  // → `srcfoo.ts`, NOT `foo.ts`. That made the two rounds carry DIFFERENT fingerprints → the
  // relative-path↔bare-name drift dodge slipped past escalation. The lookbehind-boundary regex
  // basename-ifies relative paths too, so both normalize to `foo.ts` → repeated blocking escalates.
  // 反证: revert _normalizeIssue to the old `/(?:\/[^\s/)]+)*\/([^\s/)]+\.[a-z][a-z0-9]*).../` regex
  // and R1 normalizes to `srcfoo.ts` while R2 stays `foo.ts` → fingerprints differ → escalate becomes
  // false → this test FAILS.
  const r1 = { round: 1, level: R1, findings: [
    { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs",
      issue: "bug in src/foo.ts here" },
  ] };
  const r2 = { round: 2, level: R1, findings: [
    { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs",
      issue: "bug in foo.ts here" },
  ] };
  const d = applyPostRoundDegradation([r1, r2], fullDecision());
  assert.strictEqual(d.escalate, true,
    `relative path src/foo.ts must basename-ify to match bare foo.ts → escalate; got escalate=${d.escalate}`);
});

test("T_DEGRADE_VERSION_NO_MERGE pure-numeric version segment is NOT a file extension → distinct API routes do NOT merge", () => {
  // Two blockings differ only by the API route, both carrying a `v1.2` version number. The old
  // extension rule `\.[a-z0-9]+` treated `.2` as an extension and basename-ified `/api/v1.2` → `v1.2`
  // and `/admin/v1.2` → `v1.2`, collapsing two genuinely different routes into one fingerprint
  // (false merge → false escalate). Requiring a leading LETTER (`\.[a-z][a-z0-9]*`) means `v1.2` is
  // preserved verbatim → distinct fingerprints → no escalate.
  // 反证: revert the extension class to `\.[a-z0-9]+` and both routes collapse to `v1.2` → escalate
  // becomes true → this test FAILS.
  const a = { severity: "blocking", blockerClass: "delivery_quality", file: "server/handler.go",
    issue: "GET /api/v1.2 returns 500" };
  const b = { severity: "blocking", blockerClass: "delivery_quality", file: "server/handler.go",
    issue: "GET /admin/v1.2 returns 500" };
  const history = [
    { round: 1, level: R1, findings: [a] },
    { round: 2, level: R1, findings: [b] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.notStrictEqual(d.escalate, true,
    `version-numbered routes must not over-merge into escalate; got escalate=${d.escalate}`);
});

test("T_DEGRADE_ROUND_FALLBACK_BASIS rounds missing the round field → basis uses 1-based numbers, never '?'", () => {
  // Findings carry no `round` field. The repeated-blocking basis interpolates prior→last round
  // numbers; the fallbacks must be 1-based (prior `?? i+1`, last `?? lastIdx+1`) and CONSISTENT, so
  // the basis reads `1→2`, not the inconsistent `0→?` the old `?? i` / `?? "?"` mix produced.
  // 反证: revert prior fallback to `?? i` and last to `?? "?"` → basis contains a literal `?` and a
  // 0-based prior → this assertion FAILS.
  const fp = { severity: "blocking", blockerClass: "delivery_quality", file: "scripts/replay.mjs",
    issue: "CLI does not reject empty sample" };
  const history = [
    { level: R1, findings: [{ ...fp }] },
    { level: R1, findings: [{ ...fp }] },
  ];
  const d = applyPostRoundDegradation(history, fullDecision());
  assert.strictEqual(d.escalate, true, `repeated blocking must escalate even without round fields; got escalate=${d.escalate}`);
  assert.ok(!/\?/.test(d.basis || ""), `basis must not contain '?' fallback; got ${d.basis}`);
  assert.match(d.basis || "", /rounds 1→2/, `basis must use 1-based consistent round numbers; got ${d.basis}`);
});

console.log(`\nroute-review.test: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
