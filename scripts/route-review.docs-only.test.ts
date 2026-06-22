// route-review.docs-only.test.ts — Phase 3 TDD: docs-only contentType + phaseType marker routing
// Tasks: T022-T027 (FR-ROUTE-003 orthogonal overlay)
//
// Asserts:
//   - Pure-doc diff (only .md files) → contentType === "docs-only"
//   - Negative (yaml config) → contentType !== "docs-only"  [falsifiability]
//   - phaseType marker short-circuits inference → contentType === "docs-only", level === R6
import { describe, it, expect } from "vitest";
import { routeReview } from "./route-review.mjs";

// Helper: build a fake diff string that mentions specific filenames in the diff header
function diffWith(...filenames: string[]): string {
  return filenames
    .map((f) => `diff --git a/${f} b/${f}\n@@ -1 +1 @@\n+changed`)
    .join("\n");
}

describe("Phase 3 docs-only routing (T022-T027)", () => {
  // ── T022: pure-doc diff → contentType = docs-only ──
  it("pure .md diff → contentType docs-only", () => {
    const input = diffWith("README.md", "docs/guide.md", "CHANGELOG.md");
    const d = routeReview({ input, diffLines: 30 });
    expect(d.contentType).toBe("docs-only");
  });

  // ── T023: negative — yaml config file present → NOT docs-only (falsifiability) ──
  // Test name contains "negative" to satisfy grep requirement
  it("config not docs-only: yaml file in diff → contentType is NOT docs-only (negative)", () => {
    const input = diffWith("README.md", "config/settings.yaml", "docs/guide.md");
    const d = routeReview({ input, diffLines: 20 });
    expect(d.contentType).not.toBe("docs-only");
  });

  // ── T024: json config also excluded ──
  it("json config not docs-only: .json file in diff → contentType is NOT docs-only (negative)", () => {
    const input = diffWith("README.md", "package.json");
    const d = routeReview({ input, diffLines: 10 });
    expect(d.contentType).not.toBe("docs-only");
  });

  // ── T025: toml config also excluded ──
  it("toml config not docs-only: .toml file in diff → contentType is NOT docs-only (negative)", () => {
    const input = diffWith("docs/intro.md", "Cargo.toml");
    const d = routeReview({ input, diffLines: 5 });
    expect(d.contentType).not.toBe("docs-only");
  });

  // ── T026: code file (non-md) also excluded ──
  it("code file not docs-only: .ts file in diff → contentType is NOT docs-only (negative)", () => {
    const input = diffWith("README.md", "src/main.ts");
    const d = routeReview({ input, diffLines: 15 });
    expect(d.contentType).not.toBe("docs-only");
  });

  // ── T027: route-003 — phaseType marker short-circuits inference, routes to R6 ──
  // Test name contains "route-003" to satisfy grep requirement
  it("route-003: phaseType=docs-only overrides non-markdown content → contentType docs-only + R6 level", () => {
    // Input is NOT markdown — it's code diff content — but phaseType marker forces docs-only
    const d = routeReview({
      phaseType: "docs-only",
      input: "some code diff content not markdown",
      diffLines: 50,
    });
    // Marker-driven routing must override content inference
    expect(d.contentType).toBe("docs-only");
    // docs-only routes to lightweight / R6 (same_source_subagent)
    expect(d.level).toBe("same_source_subagent");
  });

  // ── T022b: orthogonal claim — docs-only does NOT affect size tiering for code-diff ──
  it("orthogonal: large code-diff (non-md files) still routes cross_source_with_subagent", () => {
    const input = diffWith("src/auth.go", "packages/core/api.ts");
    // Large diff of code files — must NOT be docs-only; size tier still rules
    const d = routeReview({ input, diffLines: 5000 });
    expect(d.contentType).not.toBe("docs-only");
    expect(d.level).toBe("cross_source_with_subagent");
  });

  // ── T027b: docs-only routes to same_source_subagent (R6) regardless of diffLines ──
  it("docs-only contentType routes to same_source_subagent (R6) for large pure-md diff", () => {
    const input = diffWith(
      "docs/a.md", "docs/b.md", "docs/c.md", "README.md",
      "docs/d.md", "docs/e.md"
    );
    // Many md files — large diffLines but still docs-only → R6
    const d = routeReview({ input, diffLines: 2000 });
    expect(d.contentType).toBe("docs-only");
    expect(d.level).toBe("same_source_subagent");
  });

  // ── T027c: invalid phaseType must fail-fast, NOT silently downgrade ──
  // Schema-drift guard: an explicit marker outside route_decision contentType enum
  // (e.g. a typo "docs_only" / "typo") must NOT pass through as contentType and
  // downgrade a large code diff to R6. It must throw.
  it("invalid phaseType (not in contentType enum) fails fast instead of downgrading large code diff to R6", () => {
    expect(() =>
      routeReview({ phaseType: "typo", input: diffWith("src/auth.go"), diffLines: 5000 })
    ).toThrow(/phaseType/i);
    // also reject a near-miss typo of a real value
    expect(() =>
      routeReview({ phaseType: "docs_only", input: "x", diffLines: 10 })
    ).toThrow(/phaseType/i);
  });

  // ── T027d: valid phaseType from the enum still works (no over-restriction) ──
  it("valid phaseType from contentType enum is accepted", () => {
    const d = routeReview({ phaseType: "code-diff", input: diffWith("src/x.ts"), diffLines: 30 });
    expect(d.contentType).toBe("code-diff");
  });
});
