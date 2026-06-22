// @ts-nocheck
import { describe, it, expect } from "vitest";
import { inferAutomaticLensPlan, getLensTriggerConfig } from "./run-delegated-precheck.mjs";

// Extract lens names from the real return value: { specs, decisions }
// specs is an array of { name, promptSpec }
function triggeredLensNames(plan) {
  return plan.specs.map((s) => s.name);
}

describe("FR-LENS-002: config-driven trigger patterns", () => {
  it("getLensTriggerConfig returns lensTriggers with expected keyword arrays", () => {
    const config = getLensTriggerConfig();
    expect(config).toHaveProperty("lensTriggers");
    const lt = config.lensTriggers;
    expect(lt).toBeTruthy();

    // Each of these keyword arrays must exist and be non-empty
    expect(Array.isArray(lt.uiKeywords)).toBe(true);
    expect(lt.uiKeywords.length).toBeGreaterThan(0);

    expect(Array.isArray(lt.evidenceKeywords)).toBe(true);
    expect(lt.evidenceKeywords.length).toBeGreaterThan(0);

    expect(Array.isArray(lt.mechanicalRiskKeywords)).toBe(true);
    expect(lt.mechanicalRiskKeywords.length).toBeGreaterThan(0);

    expect(Array.isArray(lt.sourceManifestKeywords)).toBe(true);
    expect(lt.sourceManifestKeywords.length).toBeGreaterThan(0);

    expect(Array.isArray(lt.requiredSkillKeywords)).toBe(true);
    expect(lt.requiredSkillKeywords.length).toBeGreaterThan(0);
  });
});

describe("FR-LENS-001: content-based lens selection", () => {
  it("a code-review checkpoint with diff markers triggers source-manifest and scope-boundary lenses", () => {
    const prompt = `
## Code Review Package
checkpoint: code-review-phase3
diff --git a/src/foo.ts b/src/foo.ts
index abc123..def456
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 export function foo() {
+  return 42;
 }
`;
    const plan = inferAutomaticLensPlan(prompt, "code-review-phase3");
    const names = triggeredLensNames(plan);

    // code-review checkpoint must fire source-manifest-auditor (hasDiff=true via "diff --git")
    expect(names).toContain("source-manifest-auditor");
    // code-review checkpoint must fire scope-boundary-auditor (hasReviewableScope=true)
    expect(names).toContain("scope-boundary-auditor");
    // code-review checkpoint must fire mechanical-grep-auditor
    expect(names).toContain("mechanical-grep-auditor");
  });

  it("a plan checkpoint does NOT trigger evidence-freshness lens from weak text signals", () => {
    // A plan body may mention "exit code" or "verify-change" in tables — must NOT fire evidence lens.
    // This guards strong-signal-v4 suppression logic.
    const prompt = `
## Plan Review Package
Review kind: plan
verify-change is used in acceptance criteria.
Exit code 0 expected.
`;
    const plan = inferAutomaticLensPlan(prompt, "plan-review");
    const names = triggeredLensNames(plan);
    // plan-traceability-auditor must fire (isPlan=true)
    expect(names).toContain("plan-traceability-auditor");
    // evidence-freshness-auditor must NOT fire (gated behind !isPlan)
    expect(names).not.toContain("evidence-freshness-auditor");
  });
});

describe("FR-LENS-003: high-risk full-lens fallback (T015)", () => {
  it("fullFallbackOnHighRisk config flag is true in route-rules.json", () => {
    const config = getLensTriggerConfig();
    expect(config.lensTriggers.fullFallbackOnHighRisk).toBe(true);
  });

  it("a high-risk keyword prompt forces required-skill-auditor even without other skill signals", () => {
    // "secret" is in scope.riskKeywords; the prompt has no required-skill signal otherwise.
    // Without T015 fallback, this minimal prompt would not trigger required-skill-auditor
    // (no hasRequiredSkill, no isDesign, no isPlan, no isTestAcceptance, no isIntake).
    // With T015: isHighRisk=true AND fullFallbackOnHighRisk=true → required-skill-auditor fires.
    const highRiskPrompt = `
## Review Package
This change updates the secret rotation logic.
Please review the following change.
`;
    const plan = inferAutomaticLensPlan(highRiskPrompt, "");
    const names = triggeredLensNames(plan);

    // PRIMARY RED anchor: required-skill-auditor must be forced by high-risk fallback
    expect(names).toContain("required-skill-auditor");
  });

  it("high-risk input triggers required-skill-auditor", () => {
    // With fullFallbackOnNoMatch=true, a plain prompt also gets all 5 core lenses via no-match
    // fallback. High-risk must also include required-skill-auditor (via forceFullLens path).
    const highRiskPrompt = `
## Review Package
This change touches migration logic.
`;
    const highRiskPlan = inferAutomaticLensPlan(highRiskPrompt, "");
    const highRiskNames = triggeredLensNames(highRiskPlan);

    // High-risk forces required-skill-auditor (forceFullLens path)
    expect(highRiskNames).toContain("required-skill-auditor");
  });

  it("a non-risk plain prompt without skill signals also triggers all 5 core lenses via no-match fallback", () => {
    // With fullFallbackOnNoMatch=true (FR-LENS-003), a bare prompt with no signals gets the full
    // core lens set — this is the no-match fallback behavior (not high-risk fallback).
    const plainPrompt = `
## Review Package
This change updates a minor utility function with no risk factors.
`;
    const plan = inferAutomaticLensPlan(plainPrompt, "");
    const names = triggeredLensNames(plan);
    // No-match fallback (fullFallbackOnNoMatch=true) fires the full core lens set
    expect(names).toContain("required-skill-auditor");
    expect(names).toContain("source-manifest-auditor");
  });

  it("FR-LENS-003 no-match path: a bare prompt with no signals triggers all 5 core lenses via fullFallbackOnNoMatch", () => {
    // Precondition: route-rules.json must have fullFallbackOnNoMatch=true
    const config = getLensTriggerConfig();
    expect(config.lensTriggers.fullFallbackOnNoMatch).toBe(true);

    // Build a bare prompt: no diff, no Source Manifest / Delta Package, no risk keyword,
    // no required-skill/evidence/ui/mechanical keywords. Checkpoint does NOT start with
    // code-review/plan/design/test-acceptance/intake.
    const barePrompt = `
## Review Package
A general review of some recent work.
`;
    const plan = inferAutomaticLensPlan(barePrompt, "generic-session-review");
    const names = triggeredLensNames(plan);

    // FR-LENS-003 full code-review fallback = these 5 CORE lenses (spec clarified 2026-06-19,
    // user-approved): legacy "7 个 lens" was the pre-task sub-reviewer count; checkpoint-specific
    // lenses (browser-qa/acceptance/plan/design/threat/verifier-closure/input-contract) are NOT
    // force-mounted — they hard-stall on a code-review change. See decision-log.
    const FULL_CORE_LENSES = [
      "source-manifest-auditor",
      "required-skill-auditor",
      "evidence-freshness-auditor",
      "scope-boundary-auditor",
      "mechanical-grep-auditor",
    ];

    // The returned lens set must be a superset of all 5 core lenses.
    // Before the fix, only input-contract-auditor fires; all 5 core lenses are absent.
    for (const lens of FULL_CORE_LENSES) {
      expect(names, `expected ${lens} to be triggered by no-match full-lens fallback`).toContain(lens);
    }
  });

  it("FR-LENS-003 full-set: a high-risk prompt with no diff and no code-review checkpoint triggers ALL 5 core lenses", () => {
    // Precondition: route-rules.json must have fullFallbackOnHighRisk=true and at least one risk keyword
    const config = getLensTriggerConfig();
    expect(config.lensTriggers.fullFallbackOnHighRisk).toBe(true);
    const riskKeywords = config.scope && config.scope.riskKeywords && config.scope.riskKeywords.keywords;
    expect(Array.isArray(riskKeywords)).toBe(true);
    expect(riskKeywords.length).toBeGreaterThan(0);

    // "secret" is a real risk keyword from route-rules.json scope.riskKeywords.keywords.
    // The prompt contains NO diff (no "diff --git"), NO Source Manifest / Delta Package section,
    // and the checkpoint does NOT start with "code-review" — so ONLY the high-risk fallback
    // can trigger the 4 additional core lenses beyond required-skill-auditor.
    const highRiskPrompt = `
## Review Package
This change updates the secret rotation logic.
Please review the following change carefully.
`;
    const plan = inferAutomaticLensPlan(highRiskPrompt, "generic-checkpoint");
    const names = triggeredLensNames(plan);

    const FULL_CORE_LENSES = [
      "source-manifest-auditor",
      "required-skill-auditor",
      "evidence-freshness-auditor",
      "scope-boundary-auditor",
      "mechanical-grep-auditor",
    ];

    // The returned lens set must be a superset of all 5 core lenses.
    // Before the fix, only required-skill-auditor fires; the other 4 are absent.
    for (const lens of FULL_CORE_LENSES) {
      expect(names, `expected ${lens} to be triggered by high-risk full-lens fallback`).toContain(lens);
    }
  });
});
