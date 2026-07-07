#!/usr/bin/env node
// run-threat-auditor.test.mjs — T018 (FR-THIRDREVIEW-004)
//
// Exercises the REAL CLI (`--spec/--auditor/--output`), not the internal
// functions, per tasks.md's requirement that the two new fixtures be
// "供 checkpoint gate_cmd 用真实 --spec/--auditor/--output CLI 断言消费".
//
// Asserts:
//   - semantic-compliant-with-keyword.md (contains sensitive vocab, but the
//     risky mechanism is explicitly negated/forbidden) → 0 findings
//     (false-positive avoidance; negation-guard regression).
//   - semantic-violation-no-keyword.md (no obvious "bypass/forge/self-attest"
//     keyword, but substantively breaks proof-independence) → ≥1 blocking
//     finding in category proof-independence (false-negative avoidance).
//   - a genuinely benign spec (no adversarial signal at all) → 0 findings
//     (baseline regression, unrelated to the negation guard).
//   - missing --auditor → non-zero exit (unchanged existing contract).
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "run-threat-auditor.mjs");
const AUDITOR = resolve(__dirname, "..", "subreviewers", "threat-modeling-auditor.md");
const FIXTURES = resolve(__dirname, "..", "__fixtures__");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fail++; console.error(`  [FAIL] ${name} — ${e.message}`); }
}

function runCLI(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function runAndReadOutput(specPath, tmp) {
  const outFile = join(tmp, "out.json");
  runCLI([`--spec=${specPath}`, `--auditor=${AUDITOR}`, `--output=${outFile}`]);
  return JSON.parse(readFileSync(outFile, "utf8"));
}

test("semantic-compliant-with-keyword.md: negated risky-mechanism spec is NOT misjudged blocking", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta-test-"));
  try {
    const specPath = join(FIXTURES, "semantic-compliant-with-keyword.md");
    const result = runAndReadOutput(specPath, tmp);
    assert.strictEqual(result.status, "ok", `expected status=ok, got ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.findings, [],
      `compliant spec must produce 0 findings despite containing sensitive vocab, got ${JSON.stringify(result.findings)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("semantic-compliant-post-negation.md: negation cue AFTER the risky term (no pre-negation cue) is NOT misjudged blocking", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta-test-"));
  try {
    const specPath = join(FIXTURES, "semantic-compliant-post-negation.md");
    const result = runAndReadOutput(specPath, tmp);
    assert.strictEqual(result.status, "ok", `expected status=ok, got ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.findings, [],
      `post-negated spec must produce 0 findings ("Self-attest is explicitly forbidden" has no negation cue before the term, only after), got ${JSON.stringify(result.findings)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("semantic-compliant-mixed-case-negation.md: uppercase/mixed-case negation cues (before AND after) are NOT misjudged blocking", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta-test-"));
  try {
    const specPath = join(FIXTURES, "semantic-compliant-mixed-case-negation.md");
    const result = runAndReadOutput(specPath, tmp);
    assert.strictEqual(result.status, "ok", `expected status=ok, got ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.findings, [],
      `mixed-case-negated spec must produce 0 findings ("MUST NOT self-attest" / "is explicitly Forbidden" negation markers must match case-insensitively), got ${JSON.stringify(result.findings)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("semantic-violation-post-negation-self-attest.md: 'self-attest is not independently verified' is NOT wrongly suppressed as compliant negation (regression: post-window marker-anywhere match wrongly treated 'not ' here as prohibiting self-attest itself)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta-test-"));
  try {
    const specPath = join(FIXTURES, "semantic-violation-post-negation-self-attest.md");
    const result = runAndReadOutput(specPath, tmp);
    assert.strictEqual(result.status, "ok", `expected status=ok, got ${JSON.stringify(result)}`);
    const hasBlockingForgeryBypass = result.findings.some(
      (f) => f.severity === "blocking" && f.category === "forgery-bypass"
    );
    assert.ok(hasBlockingForgeryBypass,
      `expected a blocking forgery-bypass finding (self-attest happening without independent verification must not be silently swallowed), got ${JSON.stringify(result.findings)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("semantic-violation-post-negation-cannot-check.md: 'attest cannot be checked by an independent verifier' is NOT wrongly suppressed as compliant negation (regression: post-window marker-anywhere match wrongly treated 'cannot' here as prohibiting the attest mechanism itself)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta-test-"));
  try {
    const specPath = join(FIXTURES, "semantic-violation-post-negation-cannot-check.md");
    const result = runAndReadOutput(specPath, tmp);
    assert.strictEqual(result.status, "ok", `expected status=ok, got ${JSON.stringify(result)}`);
    const hasBlockingForgeryBypass = result.findings.some(
      (f) => f.severity === "blocking" && f.category === "forgery-bypass"
    );
    assert.ok(hasBlockingForgeryBypass,
      `expected a blocking forgery-bypass finding (an attest mechanism that cannot actually be checked by an independent verifier must not be silently swallowed), got ${JSON.stringify(result.findings)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("semantic-violation-no-keyword.md: real defect without an obvious trigger word is still caught", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta-test-"));
  try {
    const specPath = join(FIXTURES, "semantic-violation-no-keyword.md");
    const result = runAndReadOutput(specPath, tmp);
    assert.strictEqual(result.status, "ok", `expected status=ok, got ${JSON.stringify(result)}`);
    assert.ok(result.findings.length >= 1,
      `expected at least one finding, got ${JSON.stringify(result.findings)}`);
    const hasBlockingProofIndependence = result.findings.some(
      (f) => f.severity === "blocking" && f.category === "proof-independence"
    );
    assert.ok(hasBlockingProofIndependence,
      `expected a blocking proof-independence finding, got ${JSON.stringify(result.findings)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("benign spec (no adversarial signal at all) → 0 findings (baseline regression)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta-test-"));
  try {
    const specPath = join(tmp, "benign.md");
    writeFileSync(specPath, "## Plain Feature Doc\n\nThis document describes a login form with email and password fields.\n");
    const result = runAndReadOutput(specPath, tmp);
    assert.deepStrictEqual(result.findings, [], `benign spec must produce 0 findings, got ${JSON.stringify(result.findings)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("missing --auditor still exits non-zero (unchanged existing contract)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta-test-"));
  try {
    const specPath = join(tmp, "spec.md");
    const outFile = join(tmp, "out.json");
    writeFileSync(specPath, "irrelevant");
    let threw = false;
    try {
      runCLI([`--spec=${specPath}`, `--output=${outFile}`]);
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true, "missing --auditor must exit non-zero");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\nrun-threat-auditor.test: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
