#!/usr/bin/env node
// evidence-packet.test.mjs — Phase 1 (EVP, 预喂事实包) tests.
// Asserts review-dispatch-adapter.sh's `_emit-evidence-packet` test subcommand
// produces a navigation/raw-fact "seed" packet that: carries no conclusion words,
// is labeled seed (not full review scope), truncates oversized raw with a marker,
// reads its on/off switch from route-rules.json featureFlags, and emits nothing
// when the flag is off. Run directly with node (no vitest):
//   node packages/core/agenthub/skills/3rd-review/scripts/evidence-packet.test.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function run(args, env = {}) {
  return execFileSync('bash', [ADAPTER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const ADAPTER = join(REPO_ROOT, 'packages/core/agenthub/harness/review-dispatch-adapter.sh');
const ROUTE_RULES = join(REPO_ROOT, 'packages/core/agenthub/skills/3rd-review/config/route-rules.json');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.error(`  FAIL - ${name}${detail ? `\n      ${detail}` : ''}`); }
}

function emit(args, env = {}) {
  return execFileSync('bash', [ADAPTER, '_emit-evidence-packet', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// A throwaway task dir so the subcommand has a valid --task-dir target.
const TASK_DIR = mkdtempSync(join(tmpdir(), 'evp-task-'));
mkdirSync(join(TASK_DIR, 'artifacts'), { recursive: true });

try {
  // --- Build a realistic input set, including an oversized raw block for truncation ---
  const changedFiles = [
    'packages/core/agenthub/harness/review-dispatch-adapter.sh',
    'packages/core/agenthub/skills/3rd-review/config/route-rules.json',
  ].join('\n');
  const diffstat = ' 2 files changed, 40 insertions(+), 3 deletions(-)';
  // Oversized raw: 500 lines, well over any sane truncation cap.
  const bigRaw = Array.from({ length: 500 }, (_, i) => `match-line-${i}: some/file.ts:${i}`).join('\n');

  const cfArg = `--changed-files=${changedFiles}`;
  const dsArg = `--diffstat=${diffstat}`;
  const fsArg = `--forbidden-status=none`;
  const tdArg = `--task-dir=${TASK_DIR}`;
  const rawArg = `--raw-search=${bigRaw}`;

  // ============ Assertion 1: no conclusion / judgment words ============
  const out1 = emit([cfArg, dsArg, fsArg, tdArg]);
  const forbiddenWords = ['must fix', 'violation', 'should', 'bug', 'incorrect'];
  const lc = out1.toLowerCase();
  const hits = forbiddenWords.filter((w) => lc.includes(w));
  ok('no conclusion words', hits.length === 0, `found: ${hits.join(', ')}`);

  // ============ Assertion 2: seed marker (not the full review scope) ============
  ok('seed marker present', /seed/i.test(out1), 'output missing "seed"');
  ok('seed labeled not-full-scope', /not the full review scope|not.*full.*scope|线索/i.test(out1),
    'output missing "not the full review scope" semantics');

  // ============ Assertion 3: oversized raw truncated with marker ============
  const out3 = emit([cfArg, dsArg, fsArg, tdArg, rawArg]);
  ok('truncation marker present', /\[truncated:/i.test(out3), 'no [truncated: ...] marker on oversized raw');
  ok('truncated output not full 500 lines',
    out3.split('\n').filter((l) => l.startsWith('match-line-')).length < 500,
    'oversized raw was not truncated');

  // ============ Assertion 4: featureFlags default enabled === true ============
  const rules = JSON.parse(readFileSync(ROUTE_RULES, 'utf8'));
  const flag = rules?.featureFlags?.review?.evidencePacket?.enabled;
  ok('featureFlags evidencePacket.enabled defaults true', flag === true,
    `route-rules.json featureFlags.review.evidencePacket.enabled = ${JSON.stringify(flag)}`);

  // ============ Assertion 5: switch off => no packet emitted ============
  const outOff = emit([cfArg, dsArg, fsArg, tdArg], { EVP_ENABLED: 'false' });
  ok('off switch emits no packet', outOff.trim().length === 0,
    `expected empty output when disabled, got ${outOff.length} chars`);

  // ============ Assertion 5b: REAL jq config off-switch (no EVP_ENABLED) ============
  // FR-CFG-001: an explicit featureFlags.review.evidencePacket.enabled=false in the
  // route-rules.json config must disable the packet. This exercises the REAL jq config
  // read via the EVP_RULES_FILE seam (NOT the EVP_ENABLED env override), so it catches
  // the jq `// true` falsy-coalescing bug where `false // true` evaluates to `true`.
  const cfgDir = mkdtempSync(join(tmpdir(), 'evp-cfg-'));
  const cfgOff = join(cfgDir, 'rules-off.json');
  writeFileSync(cfgOff, JSON.stringify({
    featureFlags: { review: { evidencePacket: { enabled: false } } },
  }));
  const outCfgOff = emit([cfArg, dsArg, fsArg, tdArg], { EVP_RULES_FILE: cfgOff });
  ok('config enabled:false disables packet (real jq path)', outCfgOff.trim().length === 0,
    `expected empty output when config disables EVP, got ${outCfgOff.length} chars`);

  // ============ Assertion 5c: REAL jq config on-switch distinguishes on from off ======
  // Companion positive: config enabled:true via the same real jq path must EMIT a packet.
  // Proves the test can tell on from off through the jq read (not vacuously passing).
  const cfgOn = join(cfgDir, 'rules-on.json');
  writeFileSync(cfgOn, JSON.stringify({
    featureFlags: { review: { evidencePacket: { enabled: true } } },
  }));
  const outCfgOn = emit([cfArg, dsArg, fsArg, tdArg], { EVP_RULES_FILE: cfgOn });
  ok('config enabled:true emits packet (real jq path)', outCfgOn.trim().length > 0,
    `expected packet output when config enables EVP, got ${outCfgOn.length} chars`);
  rmSync(cfgDir, { recursive: true, force: true });

  // ============ Assertion 6 (F1): delegated final package CARRIES the Evidence Packet ===
  // The delegated path rebuilds PROMPT_FILE from carried sections only; without the
  // evidence_packet carry the EVP block becomes an orphan. Drive the SAME live
  // assemble_final_review_package via the _assemble-final-package test subcommand on a
  // prompt that already contains a "## Evidence Packet" section, and assert the rebuilt
  // package still carries it. Falsifiable: deleting the evidence_packet carry write in
  // assemble_final_review_package makes this assertion go red.
  const f1Prompt = join(TASK_DIR, 'f1-prompt.md');
  const f1Bundle = join(TASK_DIR, 'f1-bundle.json');
  const f1Out = join(TASK_DIR, 'f1-out.md');
  writeFileSync(f1Prompt, [
    'reviewRequestId: req-f1-test',
    'checkpoint: code-review',
    'round: 1',
    '',
    '## Current Worktree Inventory',
    '',
    '- foo.ts (modified)',
    '',
    '## Routing Decision',
    '',
    'route_level: standard',
    '',
    '## Evidence Packet — seed (not the full review scope)',
    '',
    'System-prefed navigation + raw facts.',
    '',
    '### Raw search output (index — top by relevance)',
    'EVP_CARRY_SENTINEL_F1',
    '',
  ].join('\n'));
  writeFileSync(f1Bundle, JSON.stringify({ finalFacingBundle: { topRisks: [], candidateFindings: [] } }));
  run(['_assemble-final-package',
    `--prompt-file=${f1Prompt}`,
    `--bundle-file=${f1Bundle}`,
    `--out-file=${f1Out}`,
    '--checkpoint-id=code-review',
    '--round=1',
  ]);
  const f1Result = readFileSync(f1Out, 'utf8');
  ok('F1: final package carries "## Evidence Packet" heading', /^##\s+Evidence Packet\b/m.test(f1Result),
    'rebuilt delegated package dropped the Evidence Packet section (orphan)');
  ok('F1: final package carries Evidence Packet body', f1Result.includes('EVP_CARRY_SENTINEL_F1'),
    'Evidence Packet body content was not carried into the final package');

  // ============ Assertion 7 (F2): live gather emits test candidates + raw search ========
  // emit_evidence_packet alone takes facts as args; the BUG is the live caller not
  // gathering test candidates / raw search. Exercise the SAME live gather code
  // (gather_and_emit_evidence_packet) via _assemble-reviewer-enrich against a synthetic
  // git repo (EVP_REPO_ROOT) with a deterministic changed file that has a sibling test.
  // Falsifiable: dropping --raw-search / the test-candidate or raw-search gathering in
  // gather_and_emit_evidence_packet removes these markers and the assertions go red.
  const synthRepo = mkdtempSync(join(tmpdir(), 'evp-synth-'));
  mkdirSync(join(synthRepo, 'src'), { recursive: true });
  writeFileSync(join(synthRepo, 'src', 'widget.ts'), 'export const a = 1;\n');
  writeFileSync(join(synthRepo, 'src', 'widget.test.ts'), 'test("widget", () => {});\n');
  // A committed file whose CONTENT references the changed file's basename, so the live
  // basename rg/grep has a deterministic hit (raw search greps file contents, not names).
  writeFileSync(join(synthRepo, 'src', 'index.ts'), "export * from './widget.ts';\n");
  const gitEnv = { GIT_TERMINAL_PROMPT: '0' };
  execFileSync('git', ['-C', synthRepo, 'init', '-q'], { env: { ...process.env, ...gitEnv } });
  execFileSync('git', ['-C', synthRepo, 'config', 'user.email', 't@t'], { env: { ...process.env } });
  execFileSync('git', ['-C', synthRepo, 'config', 'user.name', 't'], { env: { ...process.env } });
  execFileSync('git', ['-C', synthRepo, 'add', '-A'], { env: { ...process.env } });
  execFileSync('git', ['-C', synthRepo, 'commit', '-qm', 'init'], { env: { ...process.env } });
  writeFileSync(join(synthRepo, 'src', 'widget.ts'), 'export const a = 2;\n'); // now dirty
  const f2Bare = join(synthRepo, 'bare.md');
  const f2Enriched = join(synthRepo, 'enriched.md');
  writeFileSync(f2Bare, 'reviewRequestId: r\ncheckpoint: code-review\nround: 1\n\nbody\n');
  run(['_assemble-reviewer-enrich',
    `--prompt-file=${f2Bare}`,
    `--enriched-out=${f2Enriched}`,
    `--repo=${synthRepo}`,
  ], { EVP_REPO_ROOT: synthRepo });
  const f2Result = readFileSync(f2Enriched, 'utf8');
  ok('F2: live enrich carries Evidence Packet', /^##\s+Evidence Packet\b/m.test(f2Result),
    'live enrich path did not append the Evidence Packet');
  ok('F2: live gather includes existing TEST candidate', f2Result.includes('src/widget.test.ts (exists)'),
    'live fact-gathering omitted the related test candidate');
  ok('F2: live gather includes raw search facts', /\[raw rg search\]/.test(f2Result),
    'live fact-gathering omitted the raw rg/grep search facts');
  rmSync(synthRepo, { recursive: true, force: true });

} finally {
  rmSync(TASK_DIR, { recursive: true, force: true });
}

console.log(`\nevidence-packet.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
