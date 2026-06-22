#!/usr/bin/env node
// finding-replay-diff.test.mjs — Phase 4 (ACPT, 质量验收 replay-diff) tests.
// Asserts finding-replay-diff.mjs compares the BLOCKING finding sets of a review
// checkpoint before vs after a change, proving "缺一即判质量下降" — a change that
// loses any pre-existing blocking finding FAILS. Identity key (FR-ACPT-002) is
// severity + normalizedFile + line + normalizedIssue, read from FULL round-N.json
// conclusion records (not reviews.jsonl summary counts). Sample-usability guard
// (FR-ACPT-001) rejects zero-finding / non-revise rounds. Run directly with node:
//   node packages/core/agenthub/skills/3rd-review/scripts/finding-replay-diff.test.mjs

import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fingerprintBlocking,
  isReviseRound,
  isUsableSample,
  diffBlockingSets,
  replayDiff,
} from './finding-replay-diff.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL - ${name}\n      ${err && err.message ? err.message : err}`);
  }
}

// External read-only historical samples (per FR-ACPT-001/004). These ARE present now;
// their absence must HARD-FAIL with the missing path named (no silent skip → no false green).
//
// SAMPLES_ROOT is INJECTED, never hardcoded to one machine: prefer ACPT_SAMPLES_ROOT,
// fall back to $TASK_TRACKING_ROOT/tasks. If neither is set the harness HARD-FAILS naming
// the missing env var — a missing root must never silently skip the sample assertions.
function resolveSamplesRoot() {
  const explicit = process.env.ACPT_SAMPLES_ROOT;
  if (explicit && explicit.trim()) return explicit.trim();
  const tt = process.env.TASK_TRACKING_ROOT;
  if (tt && tt.trim()) return join(tt.trim(), 'tasks');
  throw new Error(
    'samples root unresolved: set ACPT_SAMPLES_ROOT (or TASK_TRACKING_ROOT) — refusing to silently skip pinned-sample assertions (FR-ACPT-001)',
  );
}
const SAMPLES_ROOT = resolveSamplesRoot();
const PINNED_SAMPLES = ['review-cost-time-reduction', 'review-adaptive-routing-cost-control'];

// FR-ACPT-001 (line 130/132): a degradation sample must have genuinely UNDERGONE route
// degradation, not merely carried a blocking finding. The real degradation signal lives in
// each task's route-decision-history.jsonl (at the task ROOT, not under .machine/source) —
// each entry records the route `level` chosen for a review round plus that round's findings.
// A degraded round = an entry whose level is the DOWNGRADED tier (same_source_subagent)
// rather than the richest cross-source tier (cross_source_with_subagent).
//
// Acceptance criterion (user-decided, escalation resolved 2026-06-19):
//   - MAIN sample (review-cost-time-reduction): assert REAL degradation occurred — its
//     route-decision-history carries downgraded-tier rounds that also have ≥1 blocking
//     finding. The data is rich (≥1 such round present), so this is falsifiable.
//   - BACKUP sample (review-adaptive-routing-cost-control): its route-decision-history is
//     thin (3 entries, none with blocking), so it CANNOT prove real degradation-with-blocking.
//     Downgraded to an EXISTENCE-ONLY assertion: the file exists and carries ≥1 route decision.
//
// Separately, countDegradationRounds (FULL round-N.json conclusion records, FR-ACPT-002) is
// retained as the quality-comparison source for the replay diff; its floor stays at the
// full-record authoritative count (16 main / 12 backup).
const PINNED_DEGRADATION_FLOOR = {
  'review-cost-time-reduction': 16,
  'review-adaptive-routing-cost-control': 12,
};

// Route tier ordering: richest → most degraded. A round is "degraded" when its level is below
// the richest tier (i.e. a downgrade actually happened).
const RICHEST_ROUTE_TIER = 'cross_source_with_subagent';

function reviewsDir(sample) {
  return join(SAMPLES_ROOT, sample, '.machine/source/reviews');
}

function routeHistoryPath(sample) {
  return join(SAMPLES_ROOT, sample, 'route-decision-history.jsonl');
}

// readRouteHistory: parse a sample's route-decision-history.jsonl into entries. Throws if the
// file is absent (falsifiability: a missing source must fail, not read as empty-and-skip).
function readRouteHistory(sample) {
  const p = routeHistoryPath(sample);
  if (!existsSync(p)) {
    throw new Error(`pinned sample route-decision-history.jsonl missing (degradation evidence required): ${p}`);
  }
  const out = [];
  for (const line of readFileSync(p, 'utf8').trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip unparseable */
    }
  }
  return out;
}

// countRealDegradationRounds: route-history entries that prove a real degradation occurred —
// the route level is the downgraded tier (not RICHEST_ROUTE_TIER) AND the round carries ≥1
// blocking finding. This is the reviewer-mandated "样本真实发生过降档" signal (round 4).
function countRealDegradationRounds(sample) {
  let n = 0;
  for (const entry of readRouteHistory(sample)) {
    const level = entry && entry.level;
    const blocking = (entry && Array.isArray(entry.findings) ? entry.findings : [])
      .filter((f) => f && f.severity === 'blocking').length;
    if (level && level !== RICHEST_ROUTE_TIER && blocking > 0) n += 1;
  }
  return n;
}

// countDegradationRounds: number of FULL conclusion records (round-N.json) for a sample
// whose verdict === "revise_required" AND has ≥1 blocking finding in findings[]. Reads full
// conclusion records, NOT reviews.jsonl summary counts (FR-ACPT-002). Throws if the reviews
// dir is absent (falsifiability: a missing source must fail, not read as 0-and-skip).
function countDegradationRounds(sample) {
  const root = reviewsDir(sample);
  if (!existsSync(root)) {
    throw new Error(`pinned sample reviews dir missing (external data required): ${root}`);
  }
  let n = 0;
  for (const checkpoint of readdirSync(root)) {
    const cpDir = join(root, checkpoint);
    let entries;
    try {
      entries = readdirSync(cpDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!/^round-\d+\.json$/.test(file)) continue;
      let round;
      try {
        round = JSON.parse(readFileSync(join(cpDir, file), 'utf8'));
      } catch {
        continue;
      }
      const blocking = (round && Array.isArray(round.findings) ? round.findings : [])
        .filter((f) => f && f.severity === 'blocking').length;
      if (round && round.verdict === 'revise_required' && blocking > 0) n += 1;
    }
  }
  return n;
}

// Find the first usable round-N.json under a sample (verdict==="revise_required" AND ≥1 blocking).
// Returns { path, round } or null. Throws if the sample dir is absent (falsifiability).
function findUsableSampleRound(sample) {
  const root = reviewsDir(sample);
  if (!existsSync(root)) {
    throw new Error(`pinned sample missing on disk (external data required, not optional): ${root}`);
  }
  for (const checkpoint of readdirSync(root)) {
    const cpDir = join(root, checkpoint);
    let entries;
    try {
      entries = readdirSync(cpDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!/^round-\d+\.json$/.test(file)) continue;
      const path = join(cpDir, file);
      let round;
      try {
        round = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue;
      }
      if (isUsableSample(round)) return { path, round };
    }
  }
  return null;
}

// ============ Assertion 1 (FR-ACPT-001): each pinned sample has a usable round ============
const foundUsable = {};
for (const sample of PINNED_SAMPLES) {
  test(`FR-ACPT-001: sample "${sample}" has at least one usable round`, () => {
    const hit = findUsableSampleRound(sample);
    assert.ok(
      hit,
      `no usable round (verdict==="revise_required" AND ≥1 blocking) found under ${reviewsDir(sample)}`,
    );
    foundUsable[sample] = hit;
  });
}

// ============ Assertion 1b (FR-ACPT-002): full-record quality-comparison floor =============
// The replay diff reads FULL round-N.json conclusion records; assert each sample carries at
// least the full-record count of revise_required+blocking rounds (16 main / 12 backup — the
// reviews.jsonl ledger shows 17 main but only 16 have a persisted full conclusion record, and
// the full record is the authoritative source under FR-ACPT-002). A thinned/swapped/wrong-path
// sample fails here instead of passing on a lucky first hit.
for (const sample of PINNED_SAMPLES) {
  const floor = PINNED_DEGRADATION_FLOOR[sample];
  test(`FR-ACPT-002: sample "${sample}" has ≥${floor} revise_required+blocking full conclusion records`, () => {
    const got = countDegradationRounds(sample);
    assert.ok(
      got >= floor,
      `pinned sample "${sample}" must carry ≥${floor} revise_required+blocking full records (FR-ACPT-002), got ${got}`,
    );
  });
}

// ============ Assertion 1c (FR-ACPT-001): sample genuinely UNDERWENT route degradation ======
// The reviewer-mandated check (round 4): verify real degradation via route-decision-history.jsonl,
// NOT inferred from revise_required+blocking alone. Acceptance criterion is asymmetric by data
// reality (user-decided on escalation): the MAIN sample must show real degradation-with-blocking;
// the BACKUP sample (thin route-history, no blocking) is existence-only.
const MAIN_SAMPLE = 'review-cost-time-reduction';
const BACKUP_SAMPLE = 'review-adaptive-routing-cost-control';

test(`FR-ACPT-001: MAIN sample "${MAIN_SAMPLE}" genuinely underwent route degradation (downgraded tier + blocking)`, () => {
  const got = countRealDegradationRounds(MAIN_SAMPLE);
  assert.ok(
    got >= 1,
    `main sample must have ≥1 real degradation round in route-decision-history.jsonl ` +
      `(level !== "${RICHEST_ROUTE_TIER}" AND ≥1 blocking finding), got ${got}`,
  );
});

test(`FR-ACPT-001: BACKUP sample "${BACKUP_SAMPLE}" has a route-decision-history (existence-only — thin data, see acceptance note)`, () => {
  // Backup route-history is thin (no blocking-bearing degradation rounds), so per the
  // user-decided acceptance criterion this is existence-only: the file must exist and carry
  // ≥1 route decision. readRouteHistory throws if the file is absent (falsifiable).
  const entries = readRouteHistory(BACKUP_SAMPLE);
  assert.ok(
    entries.length >= 1,
    `backup sample route-decision-history.jsonl must carry ≥1 route decision entry, got ${entries.length}`,
  );
});

// ============ Assertion 2 (FR-ACPT-002): identity key = sev+normFile+line+normIssue ====
test('FR-ACPT-002: fingerprint ignores non-normalized file/issue differences', () => {
  const a = { severity: 'blocking', file: './A.ts', line: 10, issue: '  Foo Bar ' };
  const b = { severity: 'blocking', file: 'a.ts', line: 10, issue: 'foo bar' };
  assert.strictEqual(
    fingerprintBlocking(a),
    fingerprintBlocking(b),
    'findings differing only in path-prefix/case/whitespace must share one fingerprint',
  );
});

test('FR-ACPT-002: fingerprint differs when severity/line/file/issue genuinely differ', () => {
  const base = { severity: 'blocking', file: 'a.ts', line: 10, issue: 'foo' };
  const diffSeverity = { ...base, severity: 'major' };
  const diffLine = { ...base, line: 11 };
  const diffFile = { ...base, file: 'b.ts' };
  const diffIssue = { ...base, issue: 'bar' };
  const baseKey = fingerprintBlocking(base);
  assert.notStrictEqual(fingerprintBlocking(diffSeverity), baseKey, 'severity should change key');
  assert.notStrictEqual(fingerprintBlocking(diffLine), baseKey, 'line should change key');
  assert.notStrictEqual(fingerprintBlocking(diffFile), baseKey, 'file should change key');
  assert.notStrictEqual(fingerprintBlocking(diffIssue), baseKey, 'issue should change key');
});

// ============ Assertion 3: verdict literal must be "revise_required", not loose "revise" ==
test('verdict literal: isReviseRound matches "revise_required" exactly, not "revise"', () => {
  assert.strictEqual(isReviseRound({ verdict: 'revise_required' }), true);
  assert.strictEqual(isReviseRound({ verdict: 'revise' }), false,
    'loose "revise" matching would zero-hit real data → false green; must be the exact literal');
});

test('verdict literal: real sample round uses the "revise_required" literal', () => {
  // Proves the data uses the EXACT string, so a loose "revise" match would zero-hit.
  const sample = PINNED_SAMPLES[0];
  const hit = foundUsable[sample] || findUsableSampleRound(sample);
  assert.ok(hit, `expected a usable round for ${sample}`);
  assert.strictEqual(hit.round.verdict, 'revise_required',
    `real sample verdict should be the literal "revise_required", got ${JSON.stringify(hit.round.verdict)}`);
  assert.strictEqual(isReviseRound(hit.round), true);
});

// ============ Assertion 4 (核心): lose-one → FAIL; all-preserved → PASS ==================
test('lose-one → FAIL: after-side missing one before-blocking is judged FAIL', () => {
  const beforeRound = {
    verdict: 'revise_required',
    findings: [
      { severity: 'blocking', file: 'a.ts', line: 1, issue: 'alpha' },
      { severity: 'blocking', file: 'b.ts', line: 2, issue: 'beta' },
    ],
  };
  const afterRound = {
    verdict: 'revise_required',
    findings: [
      { severity: 'blocking', file: 'a.ts', line: 1, issue: 'alpha' },
      // beta lost
    ],
  };
  const result = replayDiff([beforeRound], [afterRound]);
  assert.strictEqual(result.judgment, 'FAIL', 'losing a before-blocking must FAIL');
  const lostKey = fingerprintBlocking({ severity: 'blocking', file: 'b.ts', line: 2, issue: 'beta' });
  assert.ok(result.missing.includes(lostKey), 'missing set must report the lost fingerprint');
});

test('all-preserved → PASS: before == after is judged PASS with empty missing set', () => {
  const round = {
    verdict: 'revise_required',
    findings: [
      { severity: 'blocking', file: 'a.ts', line: 1, issue: 'alpha' },
      { severity: 'blocking', file: 'b.ts', line: 2, issue: 'beta' },
    ],
  };
  const result = replayDiff([round], [round]);
  assert.strictEqual(result.judgment, 'PASS', 'preserving every before-blocking must PASS');
  assert.strictEqual(result.missing.length, 0, 'no findings should be reported missing');
});

// ============ FR-ACPT-001: replayDiff must REJECT unusable before-samples ==============
// Zero blocking on the before side means there is nothing to compare — the gate cannot
// prove "no quality drop", so it must FAIL, never PASS (empty-sample false-green guard).
test('FR-ACPT-001: empty before-side → FAIL (nothing to compare, not PASS)', () => {
  const result = replayDiff([], []);
  assert.strictEqual(result.judgment, 'FAIL', 'empty before-side must FAIL, not PASS');
});

test('FR-ACPT-001: revise_required + zero blocking before-side → FAIL', () => {
  const zeroBlocking = {
    verdict: 'revise_required',
    findings: [{ severity: 'minor', file: 'a.ts', line: 1, issue: 'x' }],
  };
  const result = replayDiff([zeroBlocking], [zeroBlocking]);
  assert.strictEqual(result.judgment, 'FAIL', 'revise round with zero blocking is not a usable sample → FAIL');
});

test('FR-ACPT-001: pass round (zero findings) before-side → FAIL', () => {
  const passRound = { verdict: 'pass', findings: [] };
  const result = replayDiff([passRound], [passRound]);
  assert.strictEqual(result.judgment, 'FAIL', 'pass/zero-finding before-side is not usable → FAIL');
});

test('diffBlockingSets: reports before-only blocking fingerprints as missing', () => {
  const before = {
    findings: [
      { severity: 'blocking', file: 'a.ts', line: 1, issue: 'alpha' },
      { severity: 'major', file: 'c.ts', line: 3, issue: 'noise' }, // non-blocking ignored
    ],
  };
  const after = { findings: [] };
  const missing = diffBlockingSets(before, after);
  assert.strictEqual(missing.length, 1, 'only the one blocking should be reported missing');
  assert.strictEqual(
    missing[0],
    fingerprintBlocking({ severity: 'blocking', file: 'a.ts', line: 1, issue: 'alpha' }),
  );
});

// ============ Assertion 5 (FR-ACPT-001): zero-finding / non-revise round is UNUSABLE =====
test('FR-ACPT-001: pass round is not a usable sample', () => {
  assert.strictEqual(isUsableSample({ verdict: 'pass', findings: [] }), false);
});

test('FR-ACPT-001: revise round with zero blocking is not a usable sample', () => {
  const round = {
    verdict: 'revise_required',
    findings: [{ severity: 'major', file: 'a.ts', line: 1, issue: 'not blocking' }],
  };
  assert.strictEqual(isUsableSample(round), false,
    'zero-blocking round proves nothing (zero-to-zero is identity)');
});

test('FR-ACPT-001: revise round with ≥1 blocking IS a usable sample', () => {
  const round = {
    verdict: 'revise_required',
    findings: [{ severity: 'blocking', file: 'a.ts', line: 1, issue: 'real' }],
  };
  assert.strictEqual(isUsableSample(round), true);
});

console.log('\n=== usable sample rounds discovered ===');
for (const sample of PINNED_SAMPLES) {
  const hit = foundUsable[sample];
  if (hit) {
    const blocking = (hit.round.findings || []).filter((f) => f.severity === 'blocking').length;
    console.log(`  ${sample}: ${hit.path} (blocking=${blocking})`);
  }
}

console.log(`\nfinding-replay-diff.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
