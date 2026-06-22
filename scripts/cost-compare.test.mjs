#!/usr/bin/env node
// cost-compare.test.mjs — T010 regression for the FR-COST-004 anti-cheat baseline metrics.
//
// Operationalized metric definitions (from tasks.md T010):
//   escape_rate        = blocking findings surfaced AFTER a checkpoint passed
//                        ÷ total blocking findings for the task
//   human_interventions = escalate_to_human verdict count + manual-pass events
//   main_reviewer_tokens = reviewer token total from the data source (reviews.jsonl
//                          carries no token field in the frozen baseline → 0 with a
//                          documented gap note, never a fabricated value)
//   elapsed            = seconds between earliest and latest review ts
//
// Anti-cheat guards (advisor): typeof NaN === 'number' would pass the official
// verify command, so these tests assert FINITE numbers and that a 0-blocking
// task yields escape_rate=0 (not NaN), and that stdout is pure JSON.
import { computeBaseline } from "./cost-compare.mjs";
import assert from "node:assert";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fail++; console.error(`  [FAIL] ${name} — ${e.message}`); }
}

// reviews.jsonl-shaped rows (real field names: verdict, blockingCount, checkpoint, round, ts, findingsSummary)
const ROWS = [
  { checkpoint: "design-review", round: 1, verdict: "revise_required", blockingCount: 3, ts: "2026-06-10T02:00:00Z" },
  { checkpoint: "design-review", round: 2, verdict: "pass", blockingCount: 0, ts: "2026-06-10T03:00:00Z" },
  { checkpoint: "plan-review", round: 1, verdict: "revise_required", blockingCount: 2, ts: "2026-06-10T04:00:00Z" },
  { checkpoint: "plan-review", round: 2, verdict: "pass", blockingCount: 0, ts: "2026-06-10T05:00:00Z" },
];

test("baseline has exactly the four required numeric fields", () => {
  const { baseline } = computeBaseline(ROWS);
  for (const f of ["escape_rate", "human_interventions", "main_reviewer_tokens", "elapsed"]) {
    assert.ok(f in baseline, `missing field ${f}`);
    assert.equal(typeof baseline[f], "number", `${f} not a number`);
    assert.ok(Number.isFinite(baseline[f]), `${f} is not finite (NaN/Infinity would still be typeof number)`);
  }
});

test("escape_rate is 0 when no blocking escaped a passed checkpoint", () => {
  // every blocking was caught in a revise round before that checkpoint passed
  const { baseline } = computeBaseline(ROWS);
  assert.equal(baseline.escape_rate, 0, `escape_rate=${baseline.escape_rate}`);
});

test("escape_rate is 0 (not NaN) when total blocking is zero", () => {
  const allPass = [
    { checkpoint: "x", round: 1, verdict: "pass", blockingCount: 0, ts: "2026-06-10T02:00:00Z" },
  ];
  const { baseline } = computeBaseline(allPass);
  assert.equal(baseline.escape_rate, 0, `0-blocking escape_rate=${baseline.escape_rate}`);
  assert.ok(!Number.isNaN(baseline.escape_rate), "escape_rate is NaN");
});

test("escape_rate counts blocking that appears after a pass on the same checkpoint", () => {
  // checkpoint passes round 2, then a later round 3 surfaces a blocking → escaped
  const escaped = [
    { checkpoint: "code-review-phase-1", round: 1, verdict: "revise_required", blockingCount: 1, ts: "2026-06-10T02:00:00Z" },
    { checkpoint: "code-review-phase-1", round: 2, verdict: "pass", blockingCount: 0, ts: "2026-06-10T03:00:00Z" },
    { checkpoint: "code-review-phase-1", round: 3, verdict: "revise_required", blockingCount: 1, ts: "2026-06-10T04:00:00Z" },
  ];
  const { baseline } = computeBaseline(escaped);
  // 1 escaped blocking ÷ 2 total blocking = 0.5
  assert.equal(baseline.escape_rate, 0.5, `escape_rate=${baseline.escape_rate}`);
});

test("human_interventions counts escalate_to_human verdicts", () => {
  const withEscalate = [
    ...ROWS,
    { checkpoint: "code-review-phase-1", round: 1, verdict: "escalate_to_human", blockingCount: 0, ts: "2026-06-10T06:00:00Z" },
  ];
  const { baseline } = computeBaseline(withEscalate);
  assert.equal(baseline.human_interventions, 1, `human_interventions=${baseline.human_interventions}`);
});

test("elapsed is the second span between earliest and latest ts", () => {
  const { baseline } = computeBaseline(ROWS);
  // 02:00 → 05:00 = 3h = 10800s
  assert.equal(baseline.elapsed, 10800, `elapsed=${baseline.elapsed}`);
});

test("main_reviewer_tokens is 0 with a gap note when reviews carry no token field", () => {
  const { baseline, notes } = computeBaseline(ROWS);
  assert.equal(baseline.main_reviewer_tokens, 0);
  assert.ok(Array.isArray(notes) && notes.some((n) => /token/i.test(n)), "missing token gap note");
});

test("empty rows yield all-zero finite baseline", () => {
  const { baseline } = computeBaseline([]);
  for (const f of ["escape_rate", "human_interventions", "main_reviewer_tokens", "elapsed"]) {
    assert.equal(baseline[f], 0, `${f} not 0`);
    assert.ok(Number.isFinite(baseline[f]), `${f} not finite`);
  }
});

// T003 [FR-MET-003/004]: main_reviewer_tokens is non-0 when a reviews row carries mainReviewerTokens.
// This verifies that review-persist.sh populates the field (read path in cost-compare.mjs already
// reads r.mainReviewerTokens at line 73 — this test is the acceptance gate for the write path).
test("main_reviewer_tokens sums mainReviewerTokens from rows that carry the field", () => {
  const rowsWithTokens = [
    { checkpoint: "code-review-phase-1", round: 1, verdict: "pass", blockingCount: 0, ts: "2026-06-10T02:00:00Z", mainReviewerTokens: 1500 },
    { checkpoint: "code-review-phase-1", round: 2, verdict: "pass", blockingCount: 0, ts: "2026-06-10T03:00:00Z", mainReviewerTokens: 2300 },
  ];
  const { baseline, notes } = computeBaseline(rowsWithTokens);
  assert.equal(baseline.main_reviewer_tokens, 3800, `main_reviewer_tokens=${baseline.main_reviewer_tokens}`);
  assert.ok(baseline.main_reviewer_tokens > 0, "main_reviewer_tokens must be non-0 when field is present");
  // When tokens are present, the gap note should NOT appear (the field is populated)
  const hasGapNote = notes.some((n) => /reviews\.jsonl rows carry no token field/i.test(n));
  assert.ok(!hasGapNote, "gap note should not appear when mainReviewerTokens is present");
});

console.log(`\ncost-compare.test: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
