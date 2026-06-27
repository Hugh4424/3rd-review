#!/usr/bin/env node
// rfx-discipline.test.mjs — Phase 6 (RFX, revise-granularity discipline) tests.
// Proves apply.md's Revise loop carries a "返修颗粒度纪律" sub-point (FR-RFX-001): when fixing a
// "required-input-missing / fallback-masking" class blocking finding, in ONE round exhaustively
// enumerate ALL required inputs of the entry point + add a failing-path test per missing input,
// AND check every caller — instead of fixing only the named field and leaving the next same-class
// field for the next round.
// The test reads workflows/vibecoding/stages/apply.md and asserts each falsifiable key phrase is
// present. Removing any key phrase from apply.md makes the corresponding assertion fail. Run via
// the pnpm bash wrapper (bare-node .mjs is blocked by the gate whitelist):
//   pnpm --filter @multica/core exec bash -c 'cd agenthub/skills/3rd-review/scripts && node rfx-discipline.test.mjs'

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts → 3rd-review → skills → agenthub → core → packages → repo root
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const APPLY_MD = join(REPO_ROOT, 'packages/core/agenthub/workflows/vibecoding/stages/apply.md');
const apply = readFileSync(APPLY_MD, 'utf8');

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

// Each assertion targets one falsifiable key phrase of the discipline. Deleting that phrase from
// apply.md flips the corresponding assertion RED.

test('section header phrase 返修颗粒度纪律 exists', () => {
  assert.ok(apply.includes('返修颗粒度纪律'), 'apply.md must carry the discipline section header 返修颗粒度纪律');
});

test('exhaustive-enumeration requirement 全部必需输入 exists', () => {
  assert.ok(apply.includes('全部必需输入'), 'apply.md must require listing 全部必需输入 (all required inputs)');
});

test('per-missing-input failing-path test phrase 各补一条失败路径测试 exists', () => {
  assert.ok(
    apply.includes('各补一条失败路径测试'),
    'apply.md must require 各补一条失败路径测试 (a failing-path test per missing input)',
  );
});

test('anti-pattern ban: both 不留 AND 下一轮 present', () => {
  assert.ok(apply.includes('不留'), 'apply.md must contain 不留 (do not leave)');
  assert.ok(apply.includes('下一轮'), 'apply.md must contain 下一轮 (next round)');
});

test('multi-caller check phrase 调用方 (point c) exists', () => {
  assert.ok(apply.includes('调用方'), 'apply.md must mention checking each 调用方 (caller)');
});

console.log(`\nrfx-discipline.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
