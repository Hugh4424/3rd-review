#!/usr/bin/env node
// run-delegated-precheck.test.mjs — T029a characterization tests
//
// Purpose: pin the current output of buildBundle / hostVerifiedFacts / precomputedEvidence
// so T029b mechanical slimming (fixing hostVerifiedFacts N+1 IO) cannot silently change
// observable behavior.
//
// Rules:
//  - Assertions target OUTPUT EQUIVALENCE (same input → same output shape/values).
//  - IO call counts are intentionally NOT asserted — T029b will reduce N+1 to 1 read.
//  - collectedAt (new Date()) is the only volatile field; it is stripped before comparison.
//  - repoRoot/taskDir contain a random tmpdir path; tests use contains() checks or
//    replace the known temp path with a placeholder when doing full-string assertions.
import { buildBundle, hostVerifiedFacts, precomputedEvidence, lensSliceForTest, inferAutomaticLensPlan, getLensTriggerConfig, normalizeStatus, invalidReportReason } from "./run-delegated-precheck.mjs";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fail++; console.error(`  [FAIL] ${name} — ${e.message}`); }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Strip collectedAt from a facts object (only volatile field). */
function stripVolatile(factsObj) {
  const copy = { ...factsObj };
  delete copy.collectedAt;
  if (copy.fourTuple) {
    // fourTuple doesn't contain collectedAt but keep it clean
  }
  return copy;
}

/** Replace all occurrences of a dynamic tmp path with a stable placeholder. */
function normalizePaths(str, tmpDir) {
  return str.replace(new RegExp(tmpDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "TMPDIR");
}

// ─────────────────────────────────────────────────────────────────────
// Section 1: buildBundle — pure function, no fs/git dependency
// ─────────────────────────────────────────────────────────────────────

test("buildBundle: empty reports → minimal bundle shape", () => {
  const { bundle, finalFacingBundle } = buildBundle([], "");
  assert.deepEqual(bundle, {
    mode: "delegated",
    topRisks: [],
    candidateFindings: [],
    recommendedFinalReadSet: [],
    coverageAccepted: [],
  });
  // With no hygiene flags, finalFacingBundle is the same object
  assert.strictEqual(finalFacingBundle, bundle);
});

test("buildBundle: ok report → coverage proof lands in coverageAccepted", () => {
  const okReport = {
    status: "ok",
    facts: ["all checks passed"],
    riskFlags: [],
    candidateFindings: [],
    coverageProof: [{
      file: "src/foo.ts",
      ranges: ["1-50"],
      coverageMetric: "line",
      assertionType: "source-manifest-auditor:coverage",
      result: "ok",
      digest: "abc123",
    }],
    mustEscalateToFinal: false,
  };
  const { bundle } = buildBundle([okReport], "");
  assert.equal(bundle.topRisks.length, 0, "no topRisks for ok report");
  assert.equal(bundle.candidateFindings.length, 0, "no candidateFindings for ok report");
  assert.equal(bundle.coverageAccepted.length, 1, "coverageAccepted gets the proof");
  assert.equal(bundle.coverageAccepted[0].file, "src/foo.ts");
  assert.equal(bundle.coverageAccepted[0].result, "ok");
});

test("buildBundle: risk report with file:line riskFlag → promoted to candidateFindings + recommendedFinalReadSet", () => {
  const riskReport = {
    status: "risk",
    facts: ["suspicious call"],
    riskFlags: [{ type: "other", target: "src/bar.ts:42", description: "suspicious call at line 42" }],
    candidateFindings: [],
    coverageProof: [],
    mustEscalateToFinal: false,
  };
  const { bundle } = buildBundle([riskReport], "");
  assert.equal(bundle.topRisks.length, 1, "one topRisk");
  assert.deepEqual(bundle.topRisks[0], {
    sourceType: "high_risk",
    target: "src/bar.ts:42",
    reason: "[other] suspicious call at line 42",
  });
  assert.equal(bundle.candidateFindings.length, 1, "one candidateFinding promoted from riskFlag");
  assert.deepEqual(bundle.candidateFindings[0], {
    file: "src/bar.ts",
    line: 42,
    code: "(no snippet)",
    confidence: "medium",
    issue: "suspicious call at line 42",
  });
  assert.equal(bundle.recommendedFinalReadSet.length, 1, "one read entry");
  assert.equal(bundle.recommendedFinalReadSet[0].sourceType, "candidate");
  assert.equal(bundle.recommendedFinalReadSet[0].target, "src/bar.ts:42");
});

test("buildBundle: candidateFindings deduplicated by file:line across reports", () => {
  const finding = { file: "src/shared.ts", line: 10, code: "x = 1", confidence: "high", issue: "duplicate issue" };
  const report1 = { status: "risk", facts: [], riskFlags: [], candidateFindings: [finding], coverageProof: [], mustEscalateToFinal: false };
  const report2 = { status: "risk", facts: [], riskFlags: [], candidateFindings: [finding], coverageProof: [], mustEscalateToFinal: false };
  const { bundle } = buildBundle([report1, report2], "");
  assert.equal(bundle.candidateFindings.length, 1, "duplicate file:line collapsed to one");
  assert.equal(bundle.candidateFindings[0].file, "src/shared.ts");
  assert.equal(bundle.candidateFindings[0].line, 10);
});

test("buildBundle: boundary_cross riskFlag → coalesced into single 'worktree hygiene' in finalFacingBundle", () => {
  const hygieneReport = {
    status: "risk",
    facts: ["scope violation"],
    riskFlags: [
      { type: "boundary_cross", target: "unrelated/path.ts", description: "out of scope file" },
      { type: "boundary_cross", target: "another/out-of-scope.ts", description: "another out of scope" },
    ],
    candidateFindings: [],
    coverageProof: [],
    mustEscalateToFinal: false,
  };
  const { bundle, finalFacingBundle } = buildBundle([hygieneReport], "");

  // bundle still has boundary_cross topRisks (both entries point to "worktree hygiene" target)
  assert.ok(bundle.topRisks.every((r) => r.target === "worktree hygiene"), "bundle topRisks all target worktree hygiene");

  // finalFacingBundle recommendedFinalReadSet has exactly one "worktree hygiene" entry
  const hygiene = finalFacingBundle.recommendedFinalReadSet.filter((e) => e.target === "worktree hygiene");
  assert.equal(hygiene.length, 1, "exactly one worktree hygiene in recommendedFinalReadSet");
  assert.ok(hygiene[0].reason.includes("out-of-scope"), "hygiene reason mentions out-of-scope");

  // raw unrelated path NOT exposed in finalFacingBundle
  const rawTargets = finalFacingBundle.recommendedFinalReadSet.map((e) => e.target);
  assert.ok(!rawTargets.includes("unrelated/path.ts"), "raw unrelated path not in finalFacingBundle readSet");
  assert.ok(!rawTargets.includes("another/out-of-scope.ts"), "second raw path not in finalFacingBundle readSet");

  // bundle !== finalFacingBundle when hygiene flags exist
  assert.notStrictEqual(bundle, finalFacingBundle, "separate objects when hygiene flags present");
});

test("buildBundle: 'unrelated/exclude before review' flag → hygiene coalescing, NOT raw exposed in finalFacing", () => {
  const unrelatedReport = {
    status: "risk",
    facts: ["stray file"],
    riskFlags: [{ type: "other", target: "stray/file.ts", description: "unrelated file, exclude before review" }],
    candidateFindings: [],
    coverageProof: [],
    mustEscalateToFinal: false,
  };
  const { finalFacingBundle } = buildBundle([unrelatedReport], "");
  const rawTargets = finalFacingBundle.recommendedFinalReadSet.map((e) => e.target);
  assert.ok(!rawTargets.includes("stray/file.ts"), "raw stray path not exposed in finalFacingBundle");
  // The hygiene coalescer adds single "worktree hygiene" entry
  assert.ok(finalFacingBundle.topRisks.some((e) => e.target === "worktree hygiene"), "worktree hygiene in topRisks");
});

test("buildBundle: FR-ref in facts + plan.md in sourceManifest → fact promoted to candidateFindings", () => {
  const frReport = {
    status: "fail",
    facts: ["FR-GUARD-001 violated in src/guard.ts"],
    riskFlags: [],
    candidateFindings: [],
    coverageProof: [],
    mustEscalateToFinal: true,
  };
  const promptWithManifest = "## Source Manifest\n- specs/my-task/plan.md\n- specs/my-task/tasks.md\n";
  const { bundle } = buildBundle([frReport], promptWithManifest);
  const frFinding = bundle.candidateFindings.find((f) => f.file === "specs/my-task/plan.md");
  assert.ok(frFinding, "FR-ref fact promoted to candidateFindings pointing at plan.md");
  assert.ok(frFinding.issue.includes("FR-GUARD-001"), "issue text contains the FR reference");
});

test("buildBundle: mustEscalateToFinal=true report → topRisks processed even if status=ok", () => {
  const escalateReport = {
    status: "ok",
    facts: [],
    riskFlags: [{ type: "other", target: "some/file.ts", description: "must escalate" }],
    candidateFindings: [],
    coverageProof: [{ file: "some/file.ts", ranges: ["1-10"], coverageMetric: "structural", assertionType: "test", result: "ok", digest: "aaa" }],
    mustEscalateToFinal: true,
  };
  const { bundle } = buildBundle([escalateReport], "");
  assert.equal(bundle.topRisks.length, 1, "topRisk added even when status=ok but mustEscalateToFinal");
  // coverageAccepted only for ok/skipped without mustEscalate... let's verify ok+mustEscalate still adds coverage
  // (status=ok → coverage block runs regardless of mustEscalateToFinal)
  assert.equal(bundle.coverageAccepted.length, 1, "coverageAccepted still populated for ok status");
});

test("buildBundle: mode field is always 'delegated'", () => {
  const { bundle, finalFacingBundle } = buildBundle([], "");
  assert.equal(bundle.mode, "delegated");
  assert.equal(finalFacingBundle.mode, "delegated");
});

// ─────────────────────────────────────────────────────────────────────
// Section 2: hostVerifiedFacts — has IO, use stable fixture
// Volatile: collectedAt only. repoRoot/taskDir paths are dynamic tmpdir.
// ─────────────────────────────────────────────────────────────────────

test("hostVerifiedFacts: stable fields from prompt with no evidence files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hvf-t029a-"));
  try {
    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-2\nround: 1\nreviewRequestId: req-stable-abc\n`;
    const result = hostVerifiedFacts(prompt);
    const f = result.facts;

    // Stable fields
    assert.equal(f.source, "host-verified-facts", "source field");
    assert.equal(f.repoRoot, tmpDir, "repoRoot from prompt");
    assert.equal(f.taskDir, tmpDir, "taskDir from prompt");
    assert.equal(f.gitHEAD, "", "gitHEAD empty for non-git dir");
    assert.equal(f.reviewRequestId, "req-stable-abc", "reviewRequestId from prompt");
    assert.equal(f.checkpoint, "phase-2", "checkpoint from prompt");
    assert.equal(f.round, "1", "round from prompt");

    // fourTuple mirrors top-level
    assert.deepEqual(f.fourTuple, {
      repoRoot: tmpDir,
      taskDir: tmpDir,
      gitHEAD: "",
      reviewRequestId: "req-stable-abc",
    });

    // No evidence files → empty arrays
    assert.equal(f.evidenceMeta.length, 0, "no evidence files");
    assert.equal(f.evidenceMismatches.length, 0, "no mismatches");
    assert.equal(f.verifyCommands.length, 0, "no verify commands");

    // mismatched array on result (not on facts)
    assert.equal(result.mismatched.length, 0, "result.mismatched empty");

    // text is a string starting with the canonical header
    assert.ok(typeof result.text === "string", "text is string");
    assert.ok(result.text.startsWith("## Host-Verified Facts"), "text starts with canonical header");
    assert.ok(result.text.includes("req-stable-abc"), "text contains reviewRequestId");
    assert.ok(result.text.includes("phase-2"), "text contains checkpoint");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("hostVerifiedFacts: two runs produce identical output except collectedAt", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hvf-t029a-dup-"));
  try {
    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-3\nround: 2\nreviewRequestId: req-dup-check\n`;
    const r1 = hostVerifiedFacts(prompt);
    const r2 = hostVerifiedFacts(prompt);
    const f1 = stripVolatile(r1.facts);
    const f2 = stripVolatile(r2.facts);
    assert.deepEqual(f1, f2, "all fields except collectedAt are stable across two runs");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("hostVerifiedFacts: evidence file found → appears in evidenceMeta with correct fields", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hvf-t029a-ev-"));
  try {
    const evidenceDir = path.join(tmpDir, "apply", "evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, "phase-1-test.json"), JSON.stringify({
      cwd: tmpDir,
      git_sha: "abc123",
      command: "pnpm test",
      exit_code: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    }), "utf8");

    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-1\nround: 1\nreviewRequestId: req-ev-abc\n`;
    const result = hostVerifiedFacts(prompt);

    // When taskDir === repoRoot the same file appears twice (taskDir + repoRoot scan)
    assert.ok(result.facts.evidenceMeta.length >= 1, "at least one evidenceMeta entry");
    const entry = result.facts.evidenceMeta.find((e) => e.path === "apply/evidence/phase-1-test.json");
    assert.ok(entry, "evidence file found by path");
    assert.equal(entry.exists, true, "entry.exists=true");
    assert.ok(typeof entry.size === "number" && entry.size > 0, "entry.size is positive number");
    assert.equal(entry.mismatch, false, "no mismatch when cwd matches repoRoot");
    assert.equal(entry.jsonFields.command, "pnpm test", "jsonFields.command parsed correctly");
    assert.equal(entry.jsonFields.exit_code, 0, "jsonFields.exit_code parsed correctly");
    assert.equal(entry.jsonFields.cwd, tmpDir, "jsonFields.cwd parsed correctly");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("hostVerifiedFacts: cwd mismatch in evidence → evidenceMismatches populated + mismatched returned", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hvf-t029a-mis-"));
  try {
    const evidenceDir = path.join(tmpDir, "apply", "evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, "phase-1-build.json"), JSON.stringify({
      cwd: "/some/other/repo",  // intentional mismatch
      git_sha: "def456",
      command: "pnpm build",
      exit_code: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    }), "utf8");

    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-1\nround: 1\nreviewRequestId: req-mis-test\n`;
    const result = hostVerifiedFacts(prompt);

    assert.ok(result.facts.evidenceMismatches.length >= 1, "mismatch detected");
    const mismatch = result.facts.evidenceMismatches.find((m) => m.path === "apply/evidence/phase-1-build.json");
    assert.ok(mismatch, "mismatch entry for phase-1-build.json");
    assert.ok(mismatch.detail.includes("/some/other/repo"), "mismatch detail contains wrong cwd");
    assert.ok(mismatch.detail.includes(tmpDir), "mismatch detail contains expected repoRoot");
    assert.ok(result.mismatched.length >= 1, "result.mismatched array non-empty");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("hostVerifiedFacts: sources metadata has expected keys", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hvf-t029a-src-"));
  try {
    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-1\nround: 1\nreviewRequestId: req-src-abc\n`;
    const result = hostVerifiedFacts(prompt);
    const s = result.facts.sources;
    assert.ok(s.repoRoot.includes("prompt:repoRoot"), "sources.repoRoot mentions prompt");
    assert.ok(s.taskDir.includes("adapter"), "sources.taskDir mentions adapter");
    assert.equal(s.gitHEAD, "git rev-parse HEAD", "sources.gitHEAD literal");
    assert.ok(s.evidenceMeta.includes("prompt paths"), "sources.evidenceMeta mentions prompt paths");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Section 3: precomputedEvidence — wraps hostVerifiedFacts + text formatting
// ─────────────────────────────────────────────────────────────────────

test("precomputedEvidence: returns a string with canonical header section", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pce-t029a-"));
  try {
    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-1\nround: 1\nreviewRequestId: req-pce-abc\n`;
    const result = precomputedEvidence(prompt);
    assert.equal(typeof result, "string", "returns string");
    assert.ok(result.startsWith("## Host-Verified Facts"), "starts with Host-Verified Facts header");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("precomputedEvidence: two runs are stable except collectedAt line", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pce-t029a-dup-"));
  try {
    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-2\nround: 1\nreviewRequestId: req-pce-dup\n`;
    const r1 = precomputedEvidence(prompt);
    const r2 = precomputedEvidence(prompt);
    // Strip collectedAt lines before comparing
    const strip = (s) => s.replace(/- collectedAt: [^\n]+/g, "- collectedAt: STRIPPED")
      .replace(/"collectedAt": "[^"]+"/g, '"collectedAt": "STRIPPED"');
    assert.equal(strip(r1), strip(r2), "output is stable across two runs after normalizing collectedAt");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("precomputedEvidence: contains Structured Host-Verified Facts JSON block", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pce-t029a-json-"));
  try {
    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-1\nround: 1\nreviewRequestId: req-json-block\n`;
    const result = precomputedEvidence(prompt);
    assert.ok(result.includes("### Structured Host-Verified Facts"), "contains structured facts heading");
    assert.ok(result.includes("```json"), "contains json code fence");
    assert.ok(result.includes('"source": "host-verified-facts"'), "json block has source field");
    assert.ok(result.includes('"reviewRequestId": "req-json-block"'), "json block has reviewRequestId");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("precomputedEvidence: contains Evidence File Details section", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pce-t029a-det-"));
  try {
    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-1\nround: 1\nreviewRequestId: req-det-abc\n`;
    const result = precomputedEvidence(prompt);
    assert.ok(result.includes("### Evidence File Details"), "contains Evidence File Details section");
    assert.ok(result.includes("Embedded phase evidence lines:"), "contains embedded phase evidence lines marker");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("precomputedEvidence: evidence file appears in detail lines", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pce-t029a-evdet-"));
  try {
    const evidenceDir = path.join(tmpDir, "apply", "evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, "phase-1-lint.json"), JSON.stringify({
      cwd: tmpDir,
      git_sha: "fff111",
      command: "pnpm lint",
      exit_code: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    }), "utf8");

    const prompt = `repoRoot: ${tmpDir}\ntaskDir: ${tmpDir}\ncheckpoint: phase-1\nround: 1\nreviewRequestId: req-evdet\n`;
    const result = precomputedEvidence(prompt);
    assert.ok(result.includes("apply/evidence/phase-1-lint.json"), "evidence file path in output");
    assert.ok(result.includes("exists=true"), "exists=true for real file");
    assert.ok(result.includes("json.command=pnpm lint"), "json.command field in detail line");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Section 4: B1/B2/B3 — REVSUB: un-truncated diff feed + over-size warning
// (T012 FR-REVSUB-001/002, T013 FR-REVSUB-003, T014 FR-REVSUB-005)
// ─────────────────────────────────────────────────────────────────────

// Build a synthetic prompt with a large Delta Package section.
// The BACK HALF (past char 16000) contains a scope violation marker.
const BACK_HALF_MARKER = "OUT_OF_ALLOWLIST_VIOLATION_MARKER_XYZ";
const OVERSIZED_MARKER = "OVERSIZED_WARNING_DETECTED";
const OLD_CAP = 16000;
const WARN_CHARS = 80000;

function buildSyntheticPrompt(diffCharCount) {
  // Construct a Delta Package section of the requested size.
  // The first 16000 chars are benign; everything after is the back-half with marker.
  const frontPad = "A".repeat(OLD_CAP); // 16000 chars of "safe" content
  const backHalf = `\n${BACK_HALF_MARKER}\n` + "B".repeat(Math.max(0, diffCharCount - OLD_CAP - BACK_HALF_MARKER.length - 2));
  const diffBody = frontPad + backHalf;
  return [
    "reviewRequestId: test-revsub-001",
    "checkpoint: code-review-phase-2",
    "round: 1",
    "",
    "## Runtime Preferences",
    '{"reviewer":{"model":"","thinking_level":"low"}}',
    "",
    "## Source Manifest",
    "- specs/my-task/spec.md",
    "",
    "## Required Read Set",
    "- packages/core/agenthub/harness/gate.sh",
    "",
    "## Delta Package",
    "",
    diffBody,
    "",
    "## Standards Sources",
    "- CLAUDE.md",
  ].join("\n");
}

test("B3-a: back-half marker IS present in scope-boundary lens with new full-feed (REVSUB FR-REVSUB-001/002)", () => {
  if (typeof lensSliceForTest !== "function") {
    throw new Error("lensSliceForTest is not exported from run-delegated-precheck.mjs — export required for B3");
  }
  const prompt = buildSyntheticPrompt(OLD_CAP + 5000); // 21000-char diff
  const slice = lensSliceForTest("scope-boundary-auditor", prompt);
  assert.ok(
    typeof slice === "string",
    "lensSliceForTest must return a string"
  );
  assert.ok(
    slice.includes(BACK_HALF_MARKER),
    `scope-boundary lens must contain back-half marker '${BACK_HALF_MARKER}' with full diff feed; got slice length ${slice.length}`
  );
});

test("B3-b: mutation — if diff is truncated at 16000 the back-half marker IS NOT visible (falsifiability)", () => {
  if (typeof lensSliceForTest !== "function") {
    throw new Error("lensSliceForTest not exported");
  }
  const prompt = buildSyntheticPrompt(OLD_CAP + 5000);
  // Simulate OLD behavior: extract the Delta Package section and slice to 16000
  const deltaStart = prompt.indexOf("## Delta Package");
  const fullDelta = prompt.slice(deltaStart);
  const truncatedPrompt = prompt.slice(0, deltaStart) + fullDelta.slice(0, OLD_CAP);
  const slice = lensSliceForTest("scope-boundary-auditor", truncatedPrompt);
  assert.ok(
    !slice.includes(BACK_HALF_MARKER),
    `With truncated diff (old behavior), back-half marker must NOT be in the slice — but it was found`
  );
});

test("B3-c: over-size warning fires when full diff exceeds SUBREVIEWER_WARN_CHARS (B2 FR-REVSUB-003)", () => {
  if (typeof lensSliceForTest !== "function") {
    throw new Error("lensSliceForTest not exported");
  }
  // Build a prompt with a diff > 80000 chars
  const prompt = buildSyntheticPrompt(WARN_CHARS + 5000);
  const slice = lensSliceForTest("scope-boundary-auditor", prompt);
  assert.ok(
    typeof slice === "string",
    "lensSliceForTest must return a string"
  );
  // The over-size warning must be machine-detectable in the slice
  assert.ok(
    slice.includes("[oversized-diff-warning]") || slice.includes("oversized") || slice.includes("WARN: diff exceeds"),
    `slice must contain an over-size warning when diff > ${WARN_CHARS}; got length ${slice.length}, start: ${slice.slice(0, 300)}`
  );
  // Content must still be full (back-half marker must still be present)
  assert.ok(
    slice.includes(BACK_HALF_MARKER),
    "full content must be preserved even when over-size warning is added (no truncation)"
  );
});

test("B3-d: small diff (below cap) has no over-size warning and no truncation", () => {
  if (typeof lensSliceForTest !== "function") {
    throw new Error("lensSliceForTest not exported");
  }
  const prompt = buildSyntheticPrompt(1000); // tiny diff
  const slice = lensSliceForTest("scope-boundary-auditor", prompt);
  assert.ok(
    !slice.includes("[oversized-diff-warning]") && !slice.includes("WARN: diff exceeds"),
    "small diff must not trigger over-size warning"
  );
});

// ─────────────────────────────────────────────────────────────────────
// Section 5: T014/T015 — config-driven lens trigger patterns (FR-LENS-001/002/003)
// ─────────────────────────────────────────────────────────────────────

// Helper: get lens names from inferAutomaticLensPlan result
function lensNames(prompt, checkpoint) {
  const { specs } = inferAutomaticLensPlan(prompt, checkpoint);
  return specs.map((s) => s.name);
}

// ── T014-a: route-rules.json must have a lensTriggers section (config-driven) ──
test("T014-a: getLensTriggerConfig exports config from route-rules.json with lensTriggers section", () => {
  // This test FAILs before T014: getLensTriggerConfig does not exist
  assert.ok(typeof getLensTriggerConfig === "function", "getLensTriggerConfig must be exported from run-delegated-precheck.mjs");
  const cfg = getLensTriggerConfig();
  assert.ok(cfg && typeof cfg === "object", "getLensTriggerConfig() must return an object");
  assert.ok("lensTriggers" in cfg, "route-rules.json must contain a lensTriggers section");
});

// ── T014-b: UI diff triggers UI-relevant lenses but NOT unrelated ones ──
test("T014-b: UI/browser diff triggers browser-qa-auditor (via ui signal), NOT plan-traceability-auditor", () => {
  // test-acceptance + UI content should trigger browser-qa-auditor
  const uiPrompt = [
    "checkpoint: test-acceptance-phase-3",
    "round: 1",
    "## Delta Package",
    "diff --git a/apps/web/components/Dashboard.tsx b/apps/web/components/Dashboard.tsx",
    "- old line",
    "+ new ui_change: responsive layout fix",
    "## Source Manifest",
    "- apps/web/components/Dashboard.tsx",
    "Precomputed Changed File Classification: ui change",
  ].join("\n");
  const names = lensNames(uiPrompt, "test-acceptance-phase-3");
  assert.ok(names.includes("browser-qa-auditor"), "UI diff must trigger browser-qa-auditor");
  assert.ok(!names.includes("plan-traceability-auditor"), "UI diff must NOT trigger plan-traceability-auditor");
});

// ── T014-c: docs/text-only diff does NOT trigger mechanical-grep or scope-boundary lenses ──
test("T014-c: docs-only diff does NOT trigger mechanical-grep-auditor or scope-boundary-auditor", () => {
  // A pure docs prompt: no diff, no checkpoint prefix that forces those lenses
  const docsPrompt = [
    "checkpoint: design-review-phase-1",
    "round: 1",
    "## Spec",
    "This is a documentation update only. No code changed.",
    "decision-log: updated entry for scenario 1",
  ].join("\n");
  const names = lensNames(docsPrompt, "design-review-phase-1");
  assert.ok(!names.includes("mechanical-grep-auditor"), "docs-only must NOT trigger mechanical-grep-auditor");
  assert.ok(!names.includes("scope-boundary-auditor"), "docs-only must NOT trigger scope-boundary-auditor");
});

// ── T014-d: lensTriggers config has expected pattern keys ──
test("T014-d: lensTriggers config contains expected trigger pattern keys", () => {
  assert.ok(typeof getLensTriggerConfig === "function", "getLensTriggerConfig must be exported");
  const cfg = getLensTriggerConfig();
  const lt = cfg.lensTriggers;
  assert.ok(lt && typeof lt === "object", "lensTriggers must be an object");
  // Must have pattern keys for the main content signals
  assert.ok(Array.isArray(lt.uiKeywords), "lensTriggers.uiKeywords must be an array");
  assert.ok(Array.isArray(lt.evidenceKeywords), "lensTriggers.evidenceKeywords must be an array");
  assert.ok(Array.isArray(lt.mechanicalRiskKeywords), "lensTriggers.mechanicalRiskKeywords must be an array");
  assert.ok(Array.isArray(lt.sourceManifestKeywords), "lensTriggers.sourceManifestKeywords must be an array");
  assert.ok(Array.isArray(lt.requiredSkillKeywords), "lensTriggers.requiredSkillKeywords must be an array");
});

// ── T015-a: high-risk diff → full lens set (all 7) fallback ──
test("T015-a: high-risk content triggers full lens fallback (FR-LENS-003)", () => {
  assert.ok(typeof getLensTriggerConfig === "function", "getLensTriggerConfig must be exported");
  const cfg = getLensTriggerConfig();
  const lt = cfg.lensTriggers;
  assert.ok(typeof lt.fullFallbackOnHighRisk === "boolean", "lensTriggers.fullFallbackOnHighRisk must be a boolean");
  assert.ok(lt.fullFallbackOnHighRisk === true, "lensTriggers.fullFallbackOnHighRisk must be true");

  // A prompt that triggers high-risk signal (auth.go is a risk keyword from route-rules.json)
  const highRiskPrompt = [
    "checkpoint: code-review-phase-2",
    "round: 1",
    "## Delta Package",
    "diff --git a/server/internal/handler/auth.go b/server/internal/handler/auth.go",
    "@@ -1,5 +1,5 @@",
    "-old line",
    "+new auth line: token validation changed",
    "Precomputed Changed File Classification: code change",
    "## Source Manifest",
    "- server/internal/handler/auth.go",
  ].join("\n");
  const names = lensNames(highRiskPrompt, "code-review-phase-2");
  // FR-LENS-003 full code-review fallback = the 5 CORE lenses (spec clarified 2026-06-19:
  // legacy "7 个 lens" was the pre-task sub-reviewer count; checkpoint-specific lenses are
  // NOT force-mounted here — they would hard-stall on a code-review change). See decision-log.
  const FULL_LENS_SET = [
    "source-manifest-auditor",
    "required-skill-auditor",
    "evidence-freshness-auditor",
    "scope-boundary-auditor",
    "mechanical-grep-auditor",
  ];
  for (const lens of FULL_LENS_SET) {
    assert.ok(names.includes(lens), `high-risk trigger must include ${lens}`);
  }
});

// ── T015-b: no-match content → full lens fallback ──
test("T015-b: no content-match → full lens fallback triggers (FR-LENS-003 fullFallbackOnNoMatch)", () => {
  assert.ok(typeof getLensTriggerConfig === "function", "getLensTriggerConfig must be exported");
  const cfg = getLensTriggerConfig();
  const lt = cfg.lensTriggers;
  assert.ok(typeof lt.fullFallbackOnNoMatch === "boolean", "lensTriggers.fullFallbackOnNoMatch must be a boolean");

  // A completely bare prompt — no recognized signals
  const barePrompt = "checkpoint: unknown-phase-1\nround: 1\nSome random unrecognized content.";
  const names = lensNames(barePrompt, "unknown-phase-1");
  // When nothing matches and fullFallbackOnNoMatch=true, should get the fallback input-contract-auditor
  // (or the full set if fullFallbackOnNoMatch forces all)
  // Current behavior: falls back to input-contract-auditor when specs.length===0
  // After T015: if fullFallbackOnNoMatch=true, that behavior is config-driven
  assert.ok(names.length >= 1, "even no-match must produce at least 1 lens (fallback)");
  if (lt.fullFallbackOnNoMatch) {
    // All 5 core lenses OR at least input-contract-auditor as documented fallback
    assert.ok(
      names.includes("input-contract-auditor") ||
      names.includes("source-manifest-auditor"),
      "no-match fallback must include input-contract-auditor or source-manifest-auditor"
    );
  }
});

// ── T014-e: strong-signal-v4 suppression preserved (plan checkpoint suppresses weak text evidence) ──
test("T014-e: strong-signal-v4 preserved — plan checkpoint with evidence text does NOT trigger evidence-freshness-auditor", () => {
  // plan review body legitimately mentions "verify-change", "exit code" etc.
  // WITHOUT the strong-signal-v4 fix, these would trigger evidence-freshness-auditor
  // which hard-stalls plan review (no apply/evidence exists for plan)
  const planPrompt = [
    "checkpoint: plan-phase-2",
    "## Plan Review Package",
    "FR-SKILL-002: verify-change --light",
    "exit code 0 means success",
    "apply/evidence/phase-2-test.json",
    "## Source Manifest",
    "- specs/my-task/plan.md",
  ].join("\n");
  const names = lensNames(planPrompt, "plan-phase-2");
  // Strong-signal-v4: plan must NOT trigger evidence-freshness-auditor via weak text signals
  assert.ok(!names.includes("evidence-freshness-auditor"), "plan checkpoint must NOT trigger evidence-freshness-auditor (strong-signal-v4)");
  // But must trigger plan-traceability-auditor
  assert.ok(names.includes("plan-traceability-auditor"), "plan checkpoint MUST trigger plan-traceability-auditor");
});

// ── T014-f: strong-signal-v4 preserved — design checkpoint with acceptance text does NOT trigger acceptance lens ──
test("T014-f: strong-signal-v4 preserved — design checkpoint with acceptance text does NOT trigger acceptance-evidence-auditor", () => {
  const designPrompt = [
    "checkpoint: design-review-phase-1",
    "## Spec",
    "acceptance criteria: system must respond within 200ms",
    "final test report: N/A (design phase)",
    "decision-log: see decision-log.md",
  ].join("\n");
  const names = lensNames(designPrompt, "design-review-phase-1");
  // Strong-signal-v4 extension: design checkpoint must NOT trigger acceptance-evidence-auditor
  assert.ok(!names.includes("acceptance-evidence-auditor"), "design checkpoint must NOT trigger acceptance-evidence-auditor (strong-signal-v4 ext)");
  // But must trigger design lenses
  assert.ok(names.includes("design-intent-auditor"), "design checkpoint MUST trigger design-intent-auditor");
});

// ─────────────────────────────────────────────────────────────────────
// Section: not_applicable is a valid empty report (regression for design-review
// where evidence-freshness-auditor legitimately returns status=not_applicable
// per its lens contract check 0 — must NOT be coerced to "unavailable"/invalid).
// ─────────────────────────────────────────────────────────────────────

test("normalizeStatus: preserves not_applicable (not coerced to unavailable)", () => {
  assert.equal(normalizeStatus("not_applicable"), "not_applicable");
  // sanity: an unknown status still falls back to unavailable
  assert.equal(normalizeStatus("bogus"), "unavailable");
});

test("invalidReportReason: not_applicable with no facts/coverageProof is VALID", () => {
  // This is exactly the shape evidence-freshness-auditor returns on a design-review
  // with no RED/GREEN evidence. Before the fix this was judged invalid → review failed.
  const report = { status: "not_applicable", facts: [], riskFlags: [], candidateFindings: [], coverageProof: [] };
  assert.equal(invalidReportReason(report), "");
});

test("invalidReportReason: skipped with no facts/coverageProof is VALID", () => {
  const report = { status: "skipped", facts: [], riskFlags: [], candidateFindings: [], coverageProof: [] };
  assert.equal(invalidReportReason(report), "");
});

test("invalidReportReason: still rejects an ok report with empty facts (no false-green)", () => {
  // Guard against over-broad fix: a lens claiming status=ok but producing nothing
  // must still be rejected.
  const report = { status: "ok", facts: [], riskFlags: [], candidateFindings: [], coverageProof: [] };
  assert.notEqual(invalidReportReason(report), "");
});

// ─────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────
console.log(`\nrun-delegated-precheck.test: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
