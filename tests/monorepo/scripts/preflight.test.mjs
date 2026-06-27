#!/usr/bin/env node
// preflight.test.mjs — Phase 5 (PRE, preflight field check) tests.
// Proves the review-dispatch-adapter.sh run_preflight reports ALL missing/malformed
// required inputs in ONE pass (FR-PRE-001), covering the 3 most error-prone param traps
// plus the revise→pass result-field drift (FR-PRE-002 ①②③④):
//   ① --checkpoint-id must be a SHORT NAME, never a full request id (with .<ts> segment).
//   ② --review-mode must not be missing on the review subcommand.
//   ③ --reviewer-runtime-id must be obtainable (non-empty).
//   ④ On a revise→pass transition (prev round verdict==revise_required), surface the 3
//      result-contract fields (reviewSnapshot / riskDisposition / worktreeInventory) that
//      are most often dropped, as an advisory failedCheck (still part of the report-all list).
// The test INVOKES the adapter (review subcommand) with a temp throwaway task-dir so it
// runs WITHOUT a live gated task, captures the JSON written to the result-file, and asserts
// the failedChecks contain every expected item in a SINGLE run (report-all-at-once), each
// with non-empty error + fixGuide. A falsifiable negative: a fully-valid construction emits
// none of these failedChecks. Run directly with node (via pnpm bash wrapper):
//   pnpm --filter @multica/core exec bash -c 'cd agenthub/skills/3rd-review/scripts && node preflight.test.mjs'

import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts → 3rd-review → skills → agenthub → core → packages → repo root
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const ADAPTER = join(REPO_ROOT, 'packages/core/agenthub/harness/review-dispatch-adapter.sh');

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

// buildTaskDir: create a throwaway task-dir whose .machine/source has a live pendingReview
// (so the FR-PRE-003 state check PASSES and execution reaches the new param/field checks)
// and a reviews.jsonl whose prev round verdict is the supplied value (drives the ④ check).
// checkpoint is the SHORT NAME; reviewRequestId is the full form for the pendingReview.
function buildTaskDir({ checkpoint, round, prevVerdict }) {
  const td = mkdtempSync(join(tmpdir(), 'pre-pf-'));
  const srcDir = join(td, '.machine', 'source');
  mkdirSync(srcDir, { recursive: true });
  const requestId = `${checkpoint}.20260620T101010.abc123`;
  const state = {
    currentStatus: 'awaiting_review',
    pendingReview: { requestId, checkpoint, round },
  };
  writeFileSync(join(srcDir, 'state.json'), JSON.stringify(state, null, 2));
  // prev round = round-1; the FR-PRE-002 ④ check looks up checkpoint==short && round==round-1.
  const prevRound = round - 1;
  if (prevRound >= 1) {
    const line = JSON.stringify({
      reviewRequestId: `${checkpoint}.20260620T100000.def456`,
      checkpoint,
      round: prevRound,
      verdict: prevVerdict,
    });
    writeFileSync(join(srcDir, 'reviews.jsonl'), line + '\n');
  }
  return { td, requestId };
}

// buildPrompt: minimal review prompt carrying an inline reviewRequestId that matches the
// pendingReview, so the FR-PRE-003 state check resolves and the new checks are reached.
function buildPrompt(td, requestId) {
  const p = join(td, 'prompt.md');
  writeFileSync(p, `reviewRequestId: ${requestId}\n\nReview the diff.\n`);
  return p;
}

// runPreflight: invoke the adapter exec subcommand (where run_preflight lives — the atomic
// `review` subcommand wraps `exec`, so exec is the host of the preflight gate) and return the
// parsed result JSON (preflight writes {passed,failedChecks,checkedAt} to --result-file).
function runPreflight(args, td) {
  const resultFile = join(td, 'result.json');
  const argv = ['exec', ...args, `--result-file=${resultFile}`];
  // --fast disables the same-host self-review guard so it does not add unrelated failures.
  // PATH is prepended with a shim dir whose claude/codex stubs fail --version, so the env probe
  // reports no_external_cli → run_preflight exits early with JSON and never runs a real review.
  const env = { ...process.env, PATH: `${shimDir()}:${process.env.PATH || ''}`, CLAUDECODE: '' };
  const res = spawnSync('bash', [ADAPTER, ...argv], {
    encoding: 'utf8',
    timeout: 60000,
    env,
  });
  let json = null;
  if (existsSync(resultFile)) {
    try {
      json = JSON.parse(readFileSync(resultFile, 'utf8'));
    } catch {
      json = null;
    }
  }
  return { exitCode: res.status, json, stderr: res.stderr, stdout: res.stdout };
}

// runReview: invoke the FULL `review` subcommand (NOT exec directly). The review subcommand
// wraps exec via `bash "$0" exec ...`; exec's preflight echoes its structured JSON to STDERR
// (and the review path uses an internal mktemp result-file we can't read). So we parse the
// preflight JSON out of the propagated stderr. PATH shim forces no_external_cli so preflight
// exits early (env fault) without running a real review — this is the path a real dispatch
// takes through preflight, exercising whether ②③ falsely fire on the review→exec hop.
function runReview(args, td) {
  const argv = ['review', ...args];
  const env = { ...process.env, PATH: `${shimDir()}:${process.env.PATH || ''}`, CLAUDECODE: '' };
  const res = spawnSync('bash', [ADAPTER, ...argv], {
    encoding: 'utf8',
    timeout: 60000,
    env,
  });
  // Extract the first {...} JSON object from stderr that carries a failedChecks array.
  let json = null;
  const stderr = res.stderr || '';
  const start = stderr.indexOf('{');
  if (start >= 0) {
    // Greedy: find the matching closing brace by scanning candidate end positions.
    for (let end = stderr.lastIndexOf('}'); end > start; end = stderr.lastIndexOf('}', end - 1)) {
      try {
        const cand = JSON.parse(stderr.slice(start, end + 1));
        if (cand && Array.isArray(cand.failedChecks)) {
          json = cand;
          break;
        }
      } catch {
        /* keep scanning */
      }
    }
  }
  return { exitCode: res.status, json, stderr, stdout: res.stdout };
}

function checkNames(json) {
  if (!json || !Array.isArray(json.failedChecks)) return [];
  return json.failedChecks.map((c) => c.check);
}
function findCheckMatching(json, substr) {
  if (!json || !Array.isArray(json.failedChecks)) return null;
  return json.failedChecks.find(
    (c) =>
      (c.check && c.check.toLowerCase().includes(substr)) ||
      (c.error && c.error.toLowerCase().includes(substr)) ||
      (c.fixGuide && c.fixGuide.toLowerCase().includes(substr)),
  );
}

const created = [];
function track(td) {
  created.push(td);
  return td;
}

// shimDir: a PATH-prepend dir whose `claude` and `codex` stubs exit non-zero on `--version`,
// forcing the adapter's env probe to report no_external_cli. This makes run_preflight emit its
// structured JSON and EXIT EARLY (the env_probe failedCheck), so it never proceeds into a real
// review dispatch (which would hang). The env_probe fault is orthogonal to the four new checks
// under test — the assertions only look for the new faults' presence/absence.
let SHIM_DIR = null;
function shimDir() {
  if (SHIM_DIR) return SHIM_DIR;
  const d = mkdtempSync(join(tmpdir(), 'pre-shim-'));
  for (const bin of ['claude', 'codex']) {
    const p = join(d, bin);
    writeFileSync(p, '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  }
  created.push(d);
  SHIM_DIR = d;
  return d;
}

// ============ Assertion 1 (FR-PRE-001 + ①②③④): report-all-at-once on a multi-fault run ====
// One invocation that is MISSING/MALFORMED on multiple fields at once:
//   - --checkpoint-id passed in FULL request-id form (has .<ts> segment) → ① must fire.
//   - --review-mode omitted → ② must fire.
//   - --reviewer-runtime-id omitted → ③ must fire.
//   - prev round verdict==revise_required → ④ NON-BLOCKING stderr advisory must appear.
// The three BLOCKING faults ①②③ must appear in failedChecks in a SINGLE run, each with
// non-empty error+fixGuide. ④ is non-blocking: it surfaces as a stderr advisory naming the
// three drift-prone result fields, NOT as a failedCheck.
test('FR-PRE-001: all three blocking faults + ④ advisory reported in ONE pass', () => {
  const checkpoint = 'code-review-phase-4';
  const { td, requestId } = buildTaskDir({ checkpoint, round: 2, prevVerdict: 'revise_required' });
  track(td);
  const prompt = buildPrompt(td, requestId);
  const fullForm = `${checkpoint}.20260619T184044.a8c808`; // BAD: full request id, not short name
  const { json, stderr } = runPreflight(
    [
      `--checkpoint-id=${fullForm}`,
      `--prompt-file=${prompt}`,
      `--task-dir=${td}`,
      `--round=2`,
      `--fast`,
      // intentionally NO --review-mode, NO --reviewer-runtime-id
    ],
    td,
  );
  assert.ok(json, 'preflight must write a structured result JSON to --result-file');
  assert.strictEqual(json.passed, false, 'multi-fault run must not pass preflight');

  const cpFault = findCheckMatching(json, 'checkpoint-id');
  assert.ok(cpFault, `① checkpoint-id-shortname fault missing. checks=${JSON.stringify(checkNames(json))}`);
  assert.ok(cpFault.error && cpFault.error.length > 0, '① error must be non-empty');
  assert.ok(cpFault.fixGuide && cpFault.fixGuide.length > 0, '① fixGuide must be non-empty');

  const rmFault = findCheckMatching(json, 'review-mode');
  assert.ok(rmFault, `② review-mode fault missing. checks=${JSON.stringify(checkNames(json))}`);
  assert.ok(rmFault.error && rmFault.error.length > 0, '② error must be non-empty');
  assert.ok(rmFault.fixGuide && rmFault.fixGuide.length > 0, '② fixGuide must be non-empty');

  const rtFault = findCheckMatching(json, 'reviewer-runtime-id');
  assert.ok(rtFault, `③ reviewer-runtime-id fault missing. checks=${JSON.stringify(checkNames(json))}`);
  assert.ok(rtFault.error && rtFault.error.length > 0, '③ error must be non-empty');
  assert.ok(rtFault.fixGuide && rtFault.fixGuide.length > 0, '③ fixGuide must be non-empty');

  // ④ revise→pass advisory: NON-BLOCKING — it must NOT appear in failedChecks, but it must
  // surface as a stderr advisory naming the three drift-prone result fields.
  const driftFault =
    findCheckMatching(json, 'reviewsnapshot') ||
    findCheckMatching(json, 'riskdisposition') ||
    findCheckMatching(json, 'worktreeinventory') ||
    findCheckMatching(json, 'result-field-drift');
  assert.ok(!driftFault, `④ must be NON-BLOCKING (not a failedCheck), got ${JSON.stringify(driftFault)}`);
  const adv = (stderr || '').toLowerCase();
  assert.ok(adv.includes('result-field-drift'), '④ stderr advisory marker missing');
  assert.ok(adv.includes('reviewsnapshot'), '④ advisory must name reviewSnapshot');
  assert.ok(adv.includes('riskdisposition'), '④ advisory must name riskDisposition');
  assert.ok(adv.includes('worktreeinventory'), '④ advisory must name worktreeInventory');
});

// ============ Assertion 2 (① isolated): a SHORT-NAME checkpoint-id is accepted ============
// Falsifiable negative for ①: when the checkpoint-id is a proper short name, no
// checkpoint-id-shortname fault is emitted.
test('① short-name --checkpoint-id does NOT raise the shortname fault', () => {
  const checkpoint = 'code-review-phase-4';
  const { td, requestId } = buildTaskDir({ checkpoint, round: 1, prevVerdict: 'pass' });
  track(td);
  const prompt = buildPrompt(td, requestId);
  const { json } = runPreflight(
    [
      `--checkpoint-id=${checkpoint}`, // GOOD: short name
      `--prompt-file=${prompt}`,
      `--task-dir=${td}`,
      `--round=1`,
      `--review-mode=full`,
      `--reviewer-runtime-id=rt-123`,
      `--fast`,
    ],
    td,
  );
  // json may be null (no failures) OR a passed:false with unrelated checks — either way the
  // checkpoint-id-shortname fault must be ABSENT.
  const cpFault = json ? findCheckMatching(json, 'checkpoint-id') : null;
  assert.ok(!cpFault, `short-name checkpoint-id must not raise a shortname fault, got ${JSON.stringify(cpFault)}`);
});

// ============ Assertion 3 (full valid construction): none of the four faults fire =========
// Fully-valid construction: short checkpoint-id, review-mode present, runtime-id present,
// and NOT a revise→pass transition (prev verdict==pass). None of ①②③④ should appear.
test('FR-PRE-001 negative: fully-valid construction emits none of the four new faults', () => {
  const checkpoint = 'code-review-phase-4';
  const { td, requestId } = buildTaskDir({ checkpoint, round: 2, prevVerdict: 'pass' });
  track(td);
  const prompt = buildPrompt(td, requestId);
  const { json } = runPreflight(
    [
      `--checkpoint-id=${checkpoint}`,
      `--prompt-file=${prompt}`,
      `--task-dir=${td}`,
      `--round=2`,
      `--review-mode=full`,
      `--reviewer-runtime-id=rt-xyz`,
      `--fast`,
    ],
    td,
  );
  for (const needle of ['checkpoint-id', 'review-mode', 'reviewer-runtime-id', 'reviewsnapshot']) {
    const fault = json ? findCheckMatching(json, needle) : null;
    assert.ok(!fault, `valid construction must NOT raise "${needle}" fault, got ${JSON.stringify(fault)}`);
  }
});

// ============ Assertion 4 (④ context-gated): no revise→pass context → no drift advisory ===
// When the prev round verdict is NOT revise_required, the ④ advisory must NOT fire even if
// the three result fields are not supplied (it is a context-gated reminder, not always-on).
test('④ context-gated: prev verdict != revise_required → no result-field advisory', () => {
  const checkpoint = 'code-review-phase-4';
  const { td, requestId } = buildTaskDir({ checkpoint, round: 2, prevVerdict: 'pass' });
  track(td);
  const prompt = buildPrompt(td, requestId);
  const { json } = runPreflight(
    [
      `--checkpoint-id=${checkpoint}`,
      `--prompt-file=${prompt}`,
      `--task-dir=${td}`,
      `--round=2`,
      `--review-mode=full`,
      `--reviewer-runtime-id=rt-xyz`,
      `--fast`,
    ],
    td,
  );
  const driftFault = json
    ? findCheckMatching(json, 'reviewsnapshot') || findCheckMatching(json, 'worktreeinventory')
    : null;
  assert.ok(!driftFault, `non-revise prev round must not raise the drift advisory, got ${JSON.stringify(driftFault)}`);
});

// ============ Assertion 4b (④ NON-BLOCKING — normal revise re-dispatch is not blocked) =====
// THE real-pipeline regression: a normal revise re-dispatch (prev round verdict==revise_required)
// with ALL required args present (role=reviewer, short checkpoint-id, review-mode, runtime-id)
// must NOT be blocked by ④. At preflight time the reviewer has not run, so "prev=revise_required"
// is true for EVERY revise retry — if ④ called _pf_add_failure it would block all of them (exit 2).
// We use the PATH shim (env fault always present), so the ONLY blocking failedCheck must be `env`:
// result-field-drift must be ABSENT from failedChecks. If ④ were blocking, failedChecks would also
// carry result-field-drift → RED. The non-blocking advisory still appears on stderr.
test('④ NON-BLOCKING: normal revise re-dispatch is not blocked (only env fault, advisory on stderr)', () => {
  const checkpoint = 'code-review-phase-4';
  const { td, requestId } = buildTaskDir({ checkpoint, round: 2, prevVerdict: 'revise_required' });
  track(td);
  const prompt = buildPrompt(td, requestId);
  const { json, stderr } = runPreflight(
    [
      `--role=reviewer`,
      `--checkpoint-id=${checkpoint}`, // short name
      `--prompt-file=${prompt}`,
      `--task-dir=${td}`,
      `--round=2`,
      `--review-mode=delegated-code`,
      `--reviewer-runtime-id=rt-revise-1`,
      `--fast`,
    ],
    td,
  );
  assert.ok(json, 'preflight JSON expected (env-fault early exit)');
  // The ONLY blocking failedCheck must be the shim-induced env fault; ④ must not add one.
  const driftFault = findCheckMatching(json, 'result-field-drift');
  assert.ok(!driftFault, `④ must NOT block a normal revise re-dispatch. checks=${JSON.stringify(checkNames(json))}`);
  assert.deepStrictEqual(
    checkNames(json),
    ['env'],
    `revise re-dispatch must only carry the shim env fault, got ${JSON.stringify(checkNames(json))}`,
  );
  // The non-blocking advisory still fires on stderr (reminder, not a gate).
  assert.ok(
    (stderr || '').toLowerCase().includes('result-field-drift'),
    'the non-blocking ④ advisory must still be emitted on stderr',
  );
});

// ============ Assertion 5 (regression — live `review` path forwards ②③) ==================
// The full `review` subcommand wraps exec via `bash "$0" exec ...`. If review fails to forward
// --review-mode / --reviewer-runtime-id into REVIEW_EXEC_ARGS, exec's preflight sees them EMPTY
// and FALSE-FAILS ②③ on EVERY real review dispatch (orphan false-positive that blocks the
// pipeline). This invokes the FULL review subcommand with a VALID construction (real prompt,
// short checkpoint, round, task-dir with pendingReview+reviews.jsonl, reviewer-role/runtime-id/
// provider, review-mode) and asserts the propagated exec preflight emits NO review-mode and NO
// reviewer-runtime-id failedChecks. RED before the forwarding fix, GREEN after.
test('regression: live `review` subcommand forwards review-mode/runtime-id → no ②③ false-fail', () => {
  const checkpoint = 'code-review-phase-4';
  const { td, requestId } = buildTaskDir({ checkpoint, round: 1, prevVerdict: 'pass' });
  track(td);
  const prompt = buildPrompt(td, requestId);
  const { json, stderr } = runReview(
    [
      `--prompt-file=${prompt}`,
      `--checkpoint-id=${checkpoint}`,
      `--task-dir=${td}`,
      `--round=1`,
      `--reviewer-role=reviewer`,
      `--reviewer-runtime-id=rt-live-123`,
      `--reviewer-provider=codex`,
      `--review-mode=delegated-code`,
    ],
    td,
  );
  // The preflight JSON must be recoverable from exec's stderr (it echoes its report there).
  assert.ok(
    json,
    `expected exec preflight JSON in review stderr (env-fault early exit). stderr=${stderr.slice(0, 400)}`,
  );
  const rmFault = findCheckMatching(json, 'review-mode');
  assert.ok(
    !rmFault,
    `② review-mode must NOT false-fail via the review→exec hop (forwarding bug). checks=${JSON.stringify(checkNames(json))}`,
  );
  const rtFault = findCheckMatching(json, 'reviewer-runtime-id');
  assert.ok(
    !rtFault,
    `③ reviewer-runtime-id must NOT false-fail via the review→exec hop (forwarding bug). checks=${JSON.stringify(checkNames(json))}`,
  );
});

// ============ Assertion 6 (role-gate — subreviewer exec exempt from ②③) =================
// The delegated precheck invokes each subreviewer via `adapter exec --role=subreviewer` WITHOUT
// --review-mode / --reviewer-runtime-id. If ②③ were ungated by role, ALL subreviewers would
// false-fail preflight (exit 2) → "delegated precheck subreviewer failure" → whole review
// returns verdict:failed. The fix gates ②③ on role=reviewer. This invokes exec with
// --role=subreviewer and NO --review-mode / --reviewer-runtime-id, asserting the preflight JSON
// carries NEITHER a review-mode NOR a reviewer-runtime-id failedCheck. RED if ②③ were ungated.
test('role-gate: --role=subreviewer exec is EXEMPT from ②③ (no review-mode/runtime-id faults)', () => {
  const checkpoint = 'code-review-phase-4';
  const { td, requestId } = buildTaskDir({ checkpoint, round: 1, prevVerdict: 'pass' });
  track(td);
  const prompt = buildPrompt(td, requestId);
  const { json } = runPreflight(
    [
      `--role=subreviewer`,
      `--checkpoint-id=${checkpoint}`,
      `--prompt-file=${prompt}`,
      `--task-dir=${td}`,
      `--round=1`,
      // intentionally NO --review-mode and NO --reviewer-runtime-id (precheck path omits them)
    ],
    td,
  );
  // The PATH shim forces an env fault, so a preflight JSON is always emitted; ②③ must be absent.
  assert.ok(json, 'preflight JSON expected (env-fault early exit)');
  const rmFault = findCheckMatching(json, 'review-mode');
  assert.ok(
    !rmFault,
    `② review-mode must NOT fire for --role=subreviewer (role-gate). checks=${JSON.stringify(checkNames(json))}`,
  );
  const rtFault = findCheckMatching(json, 'reviewer-runtime-id');
  assert.ok(
    !rtFault,
    `③ reviewer-runtime-id must NOT fire for --role=subreviewer (role-gate). checks=${JSON.stringify(checkNames(json))}`,
  );
});

// ============ Assertion 6b: role=reviewer STILL requires ②③ (gate is selective, not blanket) =
// Counterpart to assertion 6: a role=reviewer exec missing --review-mode / --reviewer-runtime-id
// MUST still raise both faults — proving the role-gate exempts subreviewers without disabling
// the checks for the real reviewer dispatch.
test('role-gate: --role=reviewer STILL requires ②③ when omitted', () => {
  const checkpoint = 'code-review-phase-4';
  const { td, requestId } = buildTaskDir({ checkpoint, round: 1, prevVerdict: 'pass' });
  track(td);
  const prompt = buildPrompt(td, requestId);
  const { json } = runPreflight(
    [
      `--role=reviewer`,
      `--checkpoint-id=${checkpoint}`,
      `--prompt-file=${prompt}`,
      `--task-dir=${td}`,
      `--round=1`,
      `--fast`,
      // NO --review-mode and NO --reviewer-runtime-id
    ],
    td,
  );
  assert.ok(json, 'preflight JSON expected');
  assert.ok(
    findCheckMatching(json, 'review-mode'),
    `② review-mode MUST fire for role=reviewer when omitted. checks=${JSON.stringify(checkNames(json))}`,
  );
  assert.ok(
    findCheckMatching(json, 'reviewer-runtime-id'),
    `③ reviewer-runtime-id MUST fire for role=reviewer when omitted. checks=${JSON.stringify(checkNames(json))}`,
  );
});

// cleanup temp dirs
process.on('exit', () => {
  for (const td of created) {
    try {
      rmSync(td, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

console.log(`\npreflight.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
