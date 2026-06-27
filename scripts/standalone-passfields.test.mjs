#!/usr/bin/env node
// standalone-passfields.test.mjs
// E2E test: exercises the REAL standalone.sh pass-evidence enforcement (L233-256).
// Spawns standalone.sh with a fake review-runner, verifies exit codes and error
// messages for each missing-field case and the all-fields-present positive case.
//
// This is the authoritative contract proof. The local-clone assertions in
// pass-evidence-suite.test.mjs remain as unit-level coverage.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const standaloneSh = resolve(here, "..", "standalone.sh");
const fakeRunner = resolve(here, "..", "__fixtures__", "fake-pass-runner.mjs");

assert.ok(existsSync(standaloneSh), `standalone.sh not found at ${standaloneSh}`);
assert.ok(existsSync(fakeRunner), `fake-runner not found at ${fakeRunner}`);

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fail++; console.error(`  [FAIL] ${name} — ${e.message}`); }
}

function runStandalone({ omitField }) {
  const tmpDir = mkdtempSync(resolve(tmpdir(), "standalone-passfields-"));
  const inputFile = resolve(tmpDir, "input.diff");
  writeFileSync(inputFile, "+console.log('test');\n-// old line\n", "utf-8");

  const env = { ...process.env };
  if (omitField !== "none") env.OMIT_FIELD = omitField;

  const result = spawnSync("bash", [
    standaloneSh,
    `--input=${inputFile}`,
    `--output-root=${tmpDir}`,
    `--review-runner=node ${fakeRunner}`,
    "--skip-manifest",
  ], { env, encoding: "utf-8", timeout: 30_000 });

  return { tmpDir, inputFile, result };
}

console.log("=== standalone.sh pass-evidence enforcement E2E ===");
console.log(`[   info] standalone.sh: ${standaloneSh}`);
console.log(`[   info] fake-runner: ${fakeRunner}`);
console.log();

// ── Negative cases: each missing field must cause exit 2 ──

for (const field of ["reviewSnapshot", "riskDisposition", "worktreeInventory"]) {
  test(`T-E2E-1: missing ${field} → exit 2 + stderr names field`, () => {
    const { tmpDir, result } = runStandalone({ omitField: field });
    try {
      assert.strictEqual(result.status, 2,
        `expected exit 2 for missing ${field}, got ${result.status}`);
      const stderr = result.stderr || "";
      assert.ok(stderr.includes(field),
        `stderr should mention "${field}". stderr: ${stderr}`);
      assert.ok(stderr.includes("pass 但缺少必带证据字段") || stderr.includes("pass missing required evidence"),
        `stderr should contain the escalation message. stderr: ${stderr}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

// ── Positive case: all 3 fields → exit 0 + verdict.json with verdict=pass ──

test("T-E2E-2: all fields present → exit 0 + pass verdict", () => {
  const { tmpDir, result } = runStandalone({ omitField: "none" });
  try {
    assert.strictEqual(result.status, 0,
      `expected exit 0 for all fields present, got ${result.status}. stderr: ${result.stderr}`);
    // Find the verdict JSON under tasks/*/reviews/
    const tasksDir = resolve(tmpDir, "tasks");
    if (!existsSync(tasksDir)) {
      assert.fail("no tasks/ dir under output-root");
    }
    const taskDirs = readdirSync(tasksDir);
    assert.ok(taskDirs.length > 0, "no task dirs found");
    const verFile = resolve(tasksDir, taskDirs[0], "reviews", "verdict-round-1.json");
    assert.ok(existsSync(verFile), `verdict file not found at ${verFile}`);
    const verdict = JSON.parse(readFileSync(verFile, "utf-8"));
    assert.strictEqual(verdict.verdict, "pass");
    assert.ok(Array.isArray(verdict.reviewSnapshot) && verdict.reviewSnapshot.length > 0,
      "reviewSnapshot should be non-empty array");
    assert.ok(Array.isArray(verdict.riskDisposition), "riskDisposition should be array");
    assert.ok(typeof verdict.worktreeInventory === "object" && verdict.worktreeInventory !== null,
      "worktreeInventory should be object");
    assert.ok(Array.isArray(verdict.worktreeInventory.included), "wi.included should be array");
    assert.ok(Array.isArray(verdict.worktreeInventory.unrelated), "wi.unrelated should be array");
    assert.ok(Array.isArray(verdict.worktreeInventory.excluded), "wi.excluded should be array");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nstandalone-passfields E2E: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
