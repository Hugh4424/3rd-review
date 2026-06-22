#!/usr/bin/env node
// extract-codex-meta.test.mjs — Phase 3 RPT (effort honest display) tests.
// Asserts the codex-meta extractor surfaces the REAL session reasoning effort from
// turn_context.effort (not 'unknown' when a real value is present), and that when
// multiple turn_contexts exist the effort stays consistent with the final reviewer
// turn rather than being silently overwritten by an unrelated later turn_context.
// Run directly with node (no vitest):
//   node packages/core/agenthub/skills/3rd-review/scripts/extract-codex-meta.test.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, 'extract-codex-meta.mjs');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.error(`  FAIL - ${name}${detail ? `\n      ${detail}` : ''}`); }
}

// Build a synthetic Codex rollout .jsonl under a sessions root and run the extractor
// against it. Returns the parsed JSON result.
function runExtract(reqId, rolloutLines) {
  const sessionsRoot = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  const rollout = join(sessionsRoot, `rollout-${Date.now()}.jsonl`);
  writeFileSync(rollout, rolloutLines.join('\n') + '\n');
  try {
    const out = execFileSync('node', [SCRIPT, reqId, sessionsRoot], { encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    rmSync(sessionsRoot, { recursive: true, force: true });
  }
}

const REQ = 'req-effort-test';
const now = new Date().toISOString();

// --- Case 1: a real turn_context.effort present => surfaced, NOT 'unknown'/null ---
const verdictMsg = JSON.stringify({ reviewRequestId: REQ, verdict: 'pass' });
const single = [
  JSON.stringify({ timestamp: now, type: 'session_meta', payload: { cli_version: '1.0', model_provider: 'codex' } }),
  JSON.stringify({ timestamp: now, type: 'turn_context', payload: { model: 'gpt-5.4', effort: 'high' } }),
  JSON.stringify({ timestamp: now, type: 'event_msg', payload: { type: 'message', message: verdictMsg } }),
];
const r1 = runExtract(REQ, single);
ok('effort extracted from turn_context.effort', r1.effort === 'high',
  `expected effort=high, got ${JSON.stringify(r1.effort)}`);
ok('real effort present is not silently null/unknown', r1.effort != null && r1.effort !== 'unknown',
  `effort was ${JSON.stringify(r1.effort)}`);

// --- Case 2: the session's real reviewer effort is set at the first turn_context.
// A LATER turn_context carrying a DIFFERENT effort must NOT overwrite the real value
// (the no-break-loop "last wins" bug). The surfaced effort must stay the session effort. ---
const multi = [
  JSON.stringify({ timestamp: now, type: 'session_meta', payload: { cli_version: '1.0', model_provider: 'codex' } }),
  // Real session reviewer effort, set once at session start.
  JSON.stringify({ timestamp: now, type: 'turn_context', payload: { model: 'gpt-5.4', effort: 'high' } }),
  JSON.stringify({ timestamp: now, type: 'event_msg', payload: { type: 'message', message: verdictMsg } }),
  // A later turn_context carrying a DIFFERENT effort must not clobber the real value.
  JSON.stringify({ timestamp: now, type: 'turn_context', payload: { model: 'gpt-5.4', effort: 'low' } }),
];
const r2 = runExtract(REQ, multi);
ok('later differing turn_context does not overwrite real session effort', r2.effort === 'high',
  `expected effort=high preserved, got ${JSON.stringify(r2.effort)}`);

console.log(`\nextract-codex-meta.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
