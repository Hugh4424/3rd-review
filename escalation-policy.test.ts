/**
 * T006b: Dynamic escalation policy fixture test (FR-REVIEW-011)
 * Tests SKILL.md-layer decision: 4 consecutive rounds same finding → escalate_to_human
 * Verifies skill-layer policy logic, NOT VerdictRouter engine internals.
 */

import { readFileSync } from "fs";
import path from "path";

const here = path.dirname(new URL(import.meta.url).pathname);

// Simulated finding structure matching reviewer output schema
interface Finding {
  severity: "blocking" | "important" | "minor";
  file: string;
  issue: string;
  category?: string;
}

interface RoundResult {
  round: number;
  verdict: "pass" | "revise_required" | "escalate_to_human";
  findings: Finding[];
}

// Verdict type matching the schema whitelist
type ReviewVerdict = "pass" | "revise_required" | "escalate_to_human";

// Simulate the SKILL.md escalation policy rule:
// "连续 4 轮同一问题 → escalate_to_human"
// Same finding = same file + same category/issue pattern
// Returns schema-compliant verdict: "escalate_to_human" | "revise_required" | "pass"
function applyEscalationPolicy(history: RoundResult[]): ReviewVerdict {
  if (history.length < 4) return "revise_required";

  const recentFour = history.slice(-4);
  const allRevise = recentFour.every((r) => r.verdict === "revise_required");
  if (!allRevise) return "revise_required";

  // Check if there is at least one blocking finding that persisted across all 4 rounds
  const firstRoundBlocking = (recentFour[0]?.findings ?? []).filter((f) => f.severity === "blocking");
  for (const finding of firstRoundBlocking) {
    const persistedAll = recentFour.every((r) =>
      r.findings.some(
        (f) =>
          f.severity === "blocking" &&
          f.file === finding.file &&
          f.issue.slice(0, 40) === finding.issue.slice(0, 40)
      )
    );
    if (persistedAll) return "escalate_to_human";
  }

  return "revise_required";
}

const SAME_FINDING: Finding = {
  severity: "blocking",
  file: "packages/core/agenthub/harness/review-dispatch-adapter.sh",
  issue: "probe-env eval-safe: output uses single-quote wrapping which fails when version string contains single quote",
  category: "correctness",
};

const HIGH_RISK_FINDING: Finding = {
  severity: "blocking",
  file: "packages/core/agenthub/skills/3rd-review/SKILL.md",
  issue: "Three-step evaluation section missing required fallback trigger",
  category: "missing_guard",
};

describe("escalation-policy (T006b)", () => {
  test("T006b-1: 1 round revise_required → revise_required (not enough rounds)", () => {
    const history: RoundResult[] = [
      { round: 1, verdict: "revise_required", findings: [SAME_FINDING] },
    ];
    expect(applyEscalationPolicy(history)).toBe("revise_required");
  });

  test("T006b-2: 3 rounds same finding → revise_required (not yet 4)", () => {
    const history: RoundResult[] = [1, 2, 3].map((round) => ({
      round,
      verdict: "revise_required" as const,
      findings: [SAME_FINDING],
    }));
    expect(applyEscalationPolicy(history)).toBe("revise_required");
  });

  test("T006b-3: 4 consecutive rounds with same blocking finding → escalate_to_human", () => {
    const history: RoundResult[] = [1, 2, 3, 4].map((round) => ({
      round,
      verdict: "revise_required" as const,
      findings: [SAME_FINDING],
    }));
    // Schema-compliant verdict: escalate_to_human (not "escalate")
    expect(applyEscalationPolicy(history)).toBe("escalate_to_human");
  });

  test("T006b-4: 4 rounds but finding resolved in round 3 → revise_required (not persistent)", () => {
    const history: RoundResult[] = [
      { round: 1, verdict: "revise_required", findings: [SAME_FINDING] },
      { round: 2, verdict: "revise_required", findings: [SAME_FINDING] },
      { round: 3, verdict: "revise_required", findings: [HIGH_RISK_FINDING] },
      { round: 4, verdict: "revise_required", findings: [HIGH_RISK_FINDING] },
    ];
    expect(applyEscalationPolicy(history)).toBe("revise_required");
  });

  test("T006b-5: rounds 1-3 same finding, round 4 pass → revise_required (not all revise)", () => {
    const history: RoundResult[] = [
      { round: 1, verdict: "revise_required", findings: [SAME_FINDING] },
      { round: 2, verdict: "revise_required", findings: [SAME_FINDING] },
      { round: 3, verdict: "revise_required", findings: [SAME_FINDING] },
      { round: 4, verdict: "pass", findings: [] },
    ];
    expect(applyEscalationPolicy(history)).toBe("revise_required");
  });

  test("T006b-6: high-risk coverage present in rounds 1-3 (before escalation)", () => {
    const preEscalationRounds: RoundResult[] = [1, 2, 3].map((round) => ({
      round,
      verdict: "revise_required" as const,
      findings: [SAME_FINDING, HIGH_RISK_FINDING],
    }));
    for (const r of preEscalationRounds) {
      const blockingCount = r.findings.filter((f) => f.severity === "blocking").length;
      expect(blockingCount).toBeGreaterThan(0);
    }
    // Not yet 4 rounds → revise_required
    expect(applyEscalationPolicy(preEscalationRounds)).toBe("revise_required");
  });

  test("T006b-7: SKILL.md contains no fixed round cap in production code reference", () => {
    const skillPath = path.join(here, "references", "verdict-dispatch.md");
    const content = readFileSync(skillPath, "utf-8");
    // No fixed round caps allowed (skill-layer policy, not engine-layer counter)
    expect(content).not.toMatch(/最多.*轮/);
    expect(content).not.toMatch(/轮次上限/);
    expect(content).not.toMatch(/max.*round/i);
    // Escalation rule must be present
    expect(content).toMatch(/连续 4 轮/);
    // Escalation is skill-layer (not engine-layer)
    expect(content).toMatch(/审查器技能层/);
    // D10 FR-SLIM anti-false-green: content moved out of the slimmed SKILL.md shell
    const shell = readFileSync(path.join(here, "SKILL.md"), "utf-8");
    expect(shell).not.toContain("连续 4 轮");
  });
});
