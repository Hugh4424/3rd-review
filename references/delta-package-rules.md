# Delta Package Construction Rules + Scope-Reduction Guard Rail Compensation + Two-Layer Structure

> This file is referenced by the 3rd-review SKILL.md thin shell. The main session does not read it; reviewers/scripts read it on demand.

## Delta Package Construction Rules

**Core principle: every round is a complete, self-contained review — but a complete review does not mean full inline content.** The prompt inlines only the current phase's key source text, git diff, risk segments, Source Manifest, and Required Read Set by default. The reviewer must read source text per the read set, and may read the full source file directly from the manifest when needed. If a required source cannot be read → `escalate_to_human`.

- **Subject under review (fully accessible, inlined on demand)**: design/plan — inline key structure, put the full document into the Source Manifest; code-review — inline the current phase's tasks section, that phase's FR section, plan phase section, git diff, and hunk context, put full file paths into the Source Manifest; test-acceptance — inline the report conclusion/risk section/acceptance summary, put the full report into the Source Manifest.
- **git diff (mandatory for code review; replaces full inline of large files)**: Round 1 — pass the full diff; Round 2+ — pass `git diff --stat` + the current round's `git diff`. Small files (≤24 KB) may be fully inlined; medium files (24 KB–80 KB) — inline diff + 80–120 lines of context around each hunk; large files (>80 KB) — full inline is forbidden by default, pass only diff + hunk context + Required Read Set. If hunk context cannot be generated / changed lines cannot be located / manifest files cannot be read → fall back to the full package; if still unavailable → `escalate_to_human`.
- **Previous-round finding closure check (Round 2+ only; additive step)**:
  - Use the `findingsSummary` quick index in `reviews.jsonl` to locate the corresponding checkpoint + round, then read the full raw JSON (`reviews/{checkpoint}/round-{round}.json`).
  - Using only `findingsSummary` is forbidden (full context is lost).
  - **Writing a "revision summary / what I changed" inside the review package is forbidden** — the reviewer must not be pre-informed of fix content; whether a finding is closed is determined independently by the reviewer.
  - The closure check is an additive check performed on top of the complete review; it does not narrow the review scope.

## No-CLI Fallback Mode (FR-REVIEW-003)

When R6 triggers a same-source sub-agent review due to `no_external_cli`, the following fallback requirements must be met (route-review.mjs only produces a verdict, not the behavioral constraints below, so this section is retained):

**Trigger condition**: `ENV_PROBE_RESULT=no_external_cli` (both CLIs failed the probe)

**Fallback requirements**:
1. **Independent context**: dispatched via `Agent(subagent_type=...)` or an equivalent mechanism; the sub-agent must not inherit the main agent's conversation history.
2. **Follow the review contract**: the sub-agent must receive the complete reviewer-contract + verifier prompt; bare "please review this code" dispatch is not allowed.
3. **Hard rails do not downgrade**: the fallback only affects the reviewer source (external CLI → internal sub-agent); it does not affect review depth — the hard rail layer is fully preserved (FR-REVIEW-004/005 constraints unchanged).
4. **Output format unchanged**: the result JSON is identical to the external-CLI path; the `provenance` field must use the verdict schema enum values (`"single-context"` / `"independent-subagent"` / `"independent-session"`); the sub-agent path uses `"independent-subagent"`.
5. **Verification method**: `jq -e .verdict reviews/{cp}/round-N.json` still exits 0; `jq -r .provenance reviews/{cp}/round-N.json` should output `independent-subagent`.

**Prohibited actions**:
- The main agent must not self-review (self-review equals no review).
- Required skills must not be skipped due to the fallback.
- A different output format must not be used to bypass gate schema validation.

## Two-Layer Structure: Hard Rail Layer vs. Mode Selection Layer

The review framework has two layers with distinct responsibilities that must not be conflated.

### Hard Rail Layer (immutable; cannot be bypassed)

The following constraints are in effect under any mode and cannot be bypassed by any mode selection:

1. **Minimum regression coverage**: every round must cover ≥80% of changed lines across all changed files in the current phase.
2. **Mandatory review of high-risk dimensions**: any part of the subject marked high-risk must be reviewed completely and cannot be downgraded to spot-checking.
3. **Failure falls back to full scope**: if a scoped review (sampling / coverage exception) fails to satisfy any guard rail → immediately fall back to a full-scope review (`fallback_full_scope`); the review must not be passed in scoped form.
4. **Independence guarantee**: the final verdict must be produced in an independent context; the main agent is not allowed to self-review and self-judge.

Guard rail failure trigger words: `fallback_full_scope` / `回退全量` (keywords; the gate may scan for these)

### Mode Selection Layer (adaptive; adjustable)

The mode is determined by the result of a three-step evaluation and includes, but is not limited to:

- External CLI review vs. main-agent sub-agent review
- Single full-scope pass vs. parallel multi-lens passes
- First-round full review vs. subsequent rounds diff-focused

Note: delegated precheck is a hard rail (see `references/execution-steps.md` step 3.5); it is not an adjustable mode.

Mode selection does not affect the validity of the hard rail layer.

## Scope-Reduction Guard Rail Compensation Mechanism

When a review package needs to reduce scope due to cost or scale, the following compensation conditions must be satisfied before proceeding; otherwise fall back to full scope:

1. **Minimum regression coverage**: after scope reduction, ≥80% of changed lines must still be covered (calculated by git diff line count).
2. **High-risk dimensions must be reviewed**: all dimensions marked `high-risk` in the spec must appear completely in the review package.
3. **Any condition not met → fall back to full scope**: immediately terminate scope reduction and reconstruct the complete review package.

**Priority vs. Delegated Trust**: the sampling fallback in DISPATCH OVERRIDE (Delegated Trust exception) only reduces redundant re-reads for low-risk sources listed in the bundle's `coverageAccepted`; it does not lower the ≥80% floor for the current round's responsibility domain. High-risk dimensions, candidate findings, and forbidden/core boundary sources are not eligible for the sampling fallback.

## Dynamic Lens Dispatch (FR-LENS-001/002/003)

`inferAutomaticLensPlan` dynamically selects lenses based on review package content; it does not enable all 7 by default.

### Configuration-Driven (FR-LENS-002)

Content matching patterns (regex/keyword lists) that trigger lenses are stored exclusively in the `lensTriggers` section of `config/route-rules.json` and are not hardcoded in the source. Configurable items:

- `uiKeywords` — matches UI/browser signals, triggers `browser-qa-auditor`
- `evidenceKeywords` — matches apply/evidence, GREEN/RED, etc., triggers `evidence-freshness-auditor`
- `mechanicalRiskKeywords` — matches mechanical risk markers, triggers `mechanical-grep-auditor`
- `sourceManifestKeywords` — matches Source Manifest, Delta Package, diff --git, etc., triggers `source-manifest-auditor`
- `requiredSkillKeywords` — matches required skill, qa-only, etc., triggers `required-skill-auditor`
- `fullFallbackOnHighRisk` (boolean) — forces full lens activation on high-risk content
- `fullFallbackOnNoMatch` (boolean) — activates the fallback lens (`input-contract-auditor`) when no content matches

Checkpoint prefix logic (`isPlan` / `isDesign` / `isTestAcceptance`, etc.) is retained in code and is not externalized to configuration.

### Strong-Signal v4 Suppression (non-negotiable)

The following suppression logic is hardcoded in `inferAutomaticLensPlan` and is not controlled by `lensTriggers`; it prevents hard review deadlocks:

- **plan checkpoint** suppresses weak textual evidence signals → does not trigger `evidence-freshness-auditor` (plan has no apply/evidence directory)
- **design checkpoint** suppresses "acceptance criteria" and similar weak text → does not trigger `acceptance-evidence-auditor` (design has no apply/evidence)

These two items are fixes for known hard-deadlock issues; changes must be validated by T014-e/T014-f tests.

### Full Fallback (FR-LENS-003)

Two situations force expanded lens coverage:

1. **High-risk content** (`fullFallbackOnHighRisk=true`): when `scope.riskKeywords` (auth.go, secret, migration, etc.) are detected, core lenses such as `required-skill-auditor` are forcibly appended to ensure full coverage.
2. **No matching content** (`fullFallbackOnNoMatch=true`): when no content signal matches, fall back to `input-contract-auditor` to check the review package's basic compliance.
