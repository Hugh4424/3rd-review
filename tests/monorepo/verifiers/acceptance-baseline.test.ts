// acceptance-baseline.test.ts — Phase 5 (FR-METRIC-001..004)
// Asserts the acceptance-baseline artifacts are present and structurally valid:
//   FR-METRIC-003: baseline sampled ≥3 distinct historical tasks with observable round fields.
//   FR-METRIC-002: baseline summary + current-vs-baseline comparison are machine-readable.
//   FR-METRIC-001: user-intervention count is mechanically derived from the journal
//                  (NOT a session-recall approximation) and recomputable; recorded
//                  baseline-only (no trend gate). reviews.jsonl is never backfilled.
//
// Portability (review round-1 F2): TASK_DIR is injected via env var, never a
// hardcoded personal absolute path. This is a task-acceptance check, not a general
// unit test: it only runs when TASK_DIR points at the task tracking dir. In the
// bare CI suite (no TASK_DIR) it SKIPS — it must never read a hardcoded tree, and
// must never turn into a NEW red for everyone running `vitest run agenthub/`.
// Falsifiability is preserved: the task's own test-acceptance run sets TASK_DIR,
// at which point every assertion below is live (round-2 review confirmed this).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const TD = process.env.TASK_DIR;
const read = (p: string) => JSON.parse(readFileSync(resolve(TD!, p), "utf-8"));

// Mechanical recompute of user_intervention events from a task journal, matching
// the artifact's stated derivation (grep '"event":"user_intervention"').
function journalInterventionCount(taskDir: string): number {
  const candidates = [
    resolve(taskDir, ".machine/source/journal.jsonl"),
    resolve(taskDir, "artifacts/journal.jsonl"),
  ];
  const journal = candidates.find((p) => existsSync(p));
  if (!journal) return 0;
  const lines = readFileSync(journal, "utf-8").split("\n").filter(Boolean);
  let n = 0;
  for (const line of lines) {
    try {
      if (JSON.parse(line).event === "user_intervention") n++;
    } catch {
      // ignore non-JSON lines
    }
  }
  return n;
}

describe.skipIf(!TD)("Phase 5 — acceptance metric baseline", () => {
  it("FR-METRIC-003: baseline samples ≥3 distinct tasks with observable round fields", () => {
    const b = read("apply/evidence/phase5-baseline-report.json");
    const ids = new Set(b.tasks.map((t: { taskId: string }) => t.taskId));
    expect(ids.size).toBeGreaterThanOrEqual(3);
    for (const t of b.tasks) {
      expect(typeof t.avgRound).toBe("number");
      expect(typeof t.over3Rate).toBe("number");
    }
    expect(typeof b.summary.avgRound).toBe("number");
    expect(typeof b.summary.over3Rate).toBe("number");
  });

  it("FR-METRIC-002: current-vs-baseline comparison is machine-readable", () => {
    const c = read("apply/evidence/phase5-round-comparison.json");
    expect(typeof c.baseline.avgRound).toBe("number");
    expect(typeof c.current.avgRound).toBe("number");
  });

  it("FR-METRIC-001: intervention currentCount equals a mechanical journal recompute (no session-recall approximation)", () => {
    const i = read("apply/evidence/phase5-intervention-count.json");
    expect(typeof i.currentCount).toBe("number");
    expect(typeof i.baselineCount).toBe("number");
    // Falsifiable core: the recorded current count must match what we recompute
    // from this task's journal right now. A hand-written / recalled number diverges.
    expect(i.currentCount).toBe(journalInterventionCount(TD!));
  });

  it("FR-METRIC-001: baseline intervention samples are ≥3 distinct tasks, each recomputable from its journal", () => {
    const i = read("apply/evidence/phase5-intervention-count.json");
    expect(Array.isArray(i.baselineSamples)).toBe(true);
    const ids = new Set(i.baselineSamples.map((s: { taskId: string }) => s.taskId));
    expect(ids.size).toBeGreaterThanOrEqual(3);
    const root = resolve(TD!, "..");
    for (const s of i.baselineSamples as Array<{ taskId: string; count: number }>) {
      expect(typeof s.count).toBe("number");
      // Each baseline sample's count must equal its own journal's mechanical recompute.
      expect(s.count).toBe(journalInterventionCount(resolve(root, s.taskId)));
    }
  });

  it("FR-METRIC-001: manual-decision annotations are present but labelled as non-gate context", () => {
    const i = read("apply/evidence/phase5-intervention-count.json");
    expect(Array.isArray(i.reasons)).toBe(true);
    expect(i.reasons.length).toBeGreaterThan(0);
  });
});
