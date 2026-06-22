// @ts-nocheck
import { describe, it, expect } from "vitest";
import { isKnownFalsePositive, loadKnownFalsePositives, buildBundle, applyKnownFalsePositiveFilter } from "./run-delegated-precheck.mjs";

// FR-BUN-001/002: bundle noise filter via known-false-positives.json (Phase 4 T019).
// These anchors drive the REAL exported functions, not a throwaway copy.

describe("FR-BUN-002: isKnownFalsePositive rule matching", () => {
  it("an ENABLED exact rule matches the named field", () => {
    const rules = [{ id: "r1", matchField: "target", matchType: "exact", pattern: "foo/bar.ts", enabled: true }];
    expect(isKnownFalsePositive({ target: "foo/bar.ts", reason: "x" }, rules)).toBe(true);
    expect(isKnownFalsePositive({ target: "foo/other.ts", reason: "x" }, rules)).toBe(false);
  });

  it("a DISABLED rule never matches (default-off semantics)", () => {
    const rules = [{ id: "r1", matchField: "reason", matchType: "substring", pattern: "noise", enabled: false }];
    expect(isKnownFalsePositive({ target: "a", reason: "this is noise" }, rules)).toBe(false);
  });

  it("substring and regex rules match when enabled; bad regex fails open (no throw)", () => {
    const sub = [{ id: "s", matchField: "reason", matchType: "substring", pattern: "flaky", enabled: true }];
    expect(isKnownFalsePositive({ target: "a", reason: "known flaky pattern" }, sub)).toBe(true);
    const rx = [{ id: "x", matchField: "target", matchType: "regex", pattern: "^gen/.*\\.ts$", enabled: true }];
    expect(isKnownFalsePositive({ target: "gen/output.ts", reason: "" }, rx)).toBe(true);
    const bad = [{ id: "b", matchField: "target", matchType: "regex", pattern: "([", enabled: true }];
    expect(() => isKnownFalsePositive({ target: "x", reason: "" }, bad)).not.toThrow();
    expect(isKnownFalsePositive({ target: "x", reason: "" }, bad)).toBe(false);
  });
});

describe("FR-BUN-001: default config does not filter (additive, default-off)", () => {
  it("the shipped known-false-positives.json has no ENABLED rules (zero filtering by default)", () => {
    const cfg = loadKnownFalsePositives();
    const enabled = (cfg.rules || []).filter((r) => r.enabled === true);
    expect(enabled.length).toBe(0);
  });

  it("FR-BUN-001: filtering covers ALL THREE prompt-facing sections (topRisks, candidateFindings, recommendedFinalReadSet)", () => {
    // A known FP must be removed from every prompt-facing bundle section — including
    // recommendedFinalReadSet, which is also injected into the reviewer prompt.
    const enabledRule = [{ id: "fp", matchField: "target", matchType: "exact", pattern: "known/fp.ts", enabled: true }];
    const bundle = {
      mode: "delegated",
      topRisks: [{ sourceType: "high_risk", target: "known/fp.ts", reason: "fp" }, { sourceType: "high_risk", target: "real.ts", reason: "real" }],
      candidateFindings: [{ target: "known/fp.ts", issue: "fp" }, { target: "keep.ts", issue: "real" }],
      recommendedFinalReadSet: [{ sourceType: "candidate", target: "known/fp.ts", reason: "fp" }, { sourceType: "candidate", target: "stay.ts", reason: "real" }],
      coverageAccepted: [],
    };
    const filtered = applyKnownFalsePositiveFilter(bundle, enabledRule);
    // The known FP is gone from every prompt-facing section...
    expect(filtered.topRisks.some((e) => e.target === "known/fp.ts")).toBe(false);
    expect(filtered.candidateFindings.some((e) => e.target === "known/fp.ts")).toBe(false);
    expect(filtered.recommendedFinalReadSet.some((e) => e.target === "known/fp.ts")).toBe(false);
    // ...and the genuine entries survive in each.
    expect(filtered.topRisks.some((e) => e.target === "real.ts")).toBe(true);
    expect(filtered.candidateFindings.some((e) => e.target === "keep.ts")).toBe(true);
    expect(filtered.recommendedFinalReadSet.some((e) => e.target === "stay.ts")).toBe(true);
  });

  it("buildBundle with default config leaves a non-false-positive topRisk intact", () => {
    // Minimal subreviewer report carrying one high-risk riskFlag → becomes a topRisk.
    const reports = [{
      lens: "scope-boundary-auditor",
      status: "risk",
      riskFlags: [{ type: "other", target: "real/file.ts", description: "a genuine risk, not a known FP" }],
    }];
    const out = buildBundle(reports, "## Review Package\n");
    const facing = out.finalFacingBundle || out.bundle;
    const targets = (facing.topRisks || []).map((t) => t.target);
    // The genuine risk must survive (default config filters nothing).
    expect(targets.some((t) => String(t).includes("real/file.ts"))).toBe(true);
  });
});
