import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Resolve paths relative to repo root (vitest runs from packages/core)
const repoRoot = path.resolve(__dirname, "../../../../../..");
const runnerPath = path.join(repoRoot, "packages/core/agenthub/skills/3rd-review/scripts/run-threat-auditor.mjs");
const auditorPath = path.join(repoRoot, "packages/core/agenthub/skills/3rd-review/subreviewers/threat-modeling-auditor.md");
const o1SpecPath = path.join(repoRoot, "specs/archive/2026-06-12-review-skill-hardening/spec.md");
const o2SpecPath = path.join(repoRoot, "specs/archive/workflow-overhead-reduction/spec.md");

function runAuditor(specArg: string): Record<string, unknown> {
  const outFile = path.join(os.tmpdir(), `threat-auditor-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    execFileSync("node", [runnerPath, `--spec=${specArg}`, `--auditor=${auditorPath}`, `--output=${outFile}`], {
      encoding: "utf8",
    });
    const raw = fs.readFileSync(outFile, "utf8");
    return JSON.parse(raw);
  } finally {
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }
}

describe("threat-modeling-auditor via run-threat-auditor.mjs (real runner)", () => {
  it("O1: review-skill-hardening spec yields >=1 blocking forgery-bypass or proof-independence finding", () => {
    const result = runAuditor(o1SpecPath) as { status: string; findings: Array<{ severity: string; category: string }> };
    const blockingAdversarial = result.findings.filter(
      (f) => f.severity === "blocking" && (f.category === "forgery-bypass" || f.category === "proof-independence"),
    );
    expect(blockingAdversarial.length).toBeGreaterThan(0);
  });

  it("O2: workflow-overhead-reduction spec yields >=1 blocking schema-drift finding", () => {
    const result = runAuditor(o2SpecPath) as { status: string; findings: Array<{ severity: string; category: string }> };
    const blockingSchemaDrift = result.findings.filter(
      (f) => f.severity === "blocking" && f.category === "schema-drift",
    );
    expect(blockingSchemaDrift.length).toBeGreaterThan(0);
  });

  it("no-spec (/dev/null) yields status=skip", () => {
    const result = runAuditor("/dev/null") as { status: string; findings: unknown[] };
    expect(result.status).toBe("skip");
    expect(result.findings).toEqual([]);
  });

  it("falsifiability guard: benign spec with no adversarial content yields 0 blocking findings", () => {
    // Write a benign spec to a temp file — no phrases that trigger any detection rule.
    const benignSpec = path.join(os.tmpdir(), `benign-spec-${Date.now()}.md`);
    fs.writeFileSync(benignSpec, [
      "# Benign Spec",
      "",
      "## Goal",
      "Build a simple read-only dashboard that displays project statistics.",
      "",
      "## Requirements",
      "- Show total issue count per project.",
      "- Show open vs closed ratio.",
      "- Refresh every 60 seconds.",
      "",
      "## Out of scope",
      "- No authentication changes.",
      "- No data writes.",
    ].join("\n"), "utf8");
    try {
      const result = runAuditor(benignSpec) as { status: string; findings: Array<{ severity: string }> };
      const blocking = result.findings.filter((f) => f.severity === "blocking");
      expect(blocking.length).toBe(0);
    } finally {
      try { fs.unlinkSync(benignSpec); } catch { /* ignore */ }
    }
  });
});
