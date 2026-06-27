// constitution-sync.test.ts — Phase 4 (FR-CONST-001 / FR-CONST-003)
// Asserts the constitution draft-chain sync invariants:
//   FR-CONST-001: constitution.md repositions base-verifier as a general protocol
//                 INSIDE the 3rd-review skill (skills/3rd-review/verifiers/base-verifier.md),
//                 no longer a platform-layer standalone prompt.
//   FR-CONST-003: base-verifier content is byte-identical to its pre-migration version
//                 (only the path/location changed; review semantics unchanged).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// repo root: this file is packages/core/agenthub/skills/3rd-review/verifiers/
const REPO_ROOT = resolve(__dirname, "../../../../../..");
const MIGRATION_COMMIT = "3ebb50d68";
const PRE_PATH = "packages/core/agenthub/prompts/base-verifier.md";
const POST_PATH =
  "packages/core/agenthub/skills/3rd-review/verifiers/base-verifier.md";

describe("Phase 4 — constitution draft-chain sync", () => {
  it("FR-CONST-001: constitution.md repositions base-verifier inside the 3rd-review skill", () => {
    const constitution = readFileSync(
      resolve(REPO_ROOT, ".specify/memory/constitution.md"),
      "utf-8"
    );
    // The Article II Enforcement clause must now point at the in-skill location.
    expect(constitution).toContain(
      "skills/3rd-review/verifiers/base-verifier.md"
    );
  });

  it("FR-CONST-003: base-verifier content is byte-identical pre/post migration (semantic diff empty)", () => {
    const pre = execSync(
      `git show ${MIGRATION_COMMIT}^:${PRE_PATH}`,
      { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 1 << 20 }
    );
    const post = readFileSync(resolve(REPO_ROOT, POST_PATH), "utf-8");
    expect(post).toBe(pre);
  });
});
