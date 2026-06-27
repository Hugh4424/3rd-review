# must-keep-checklist.md

> AC-7 diff baseline. Static reference document — not executable, not dynamic.
> Each bullet references a present file/function verified at creation time (Phase 4).
> Future changes diff against this file to confirm AC-7 contract retention.

## 1. Heterologous routing (R1/R2/R6)
- `scripts/route-review.mjs`: `routeReview()` returns `RouteDecision.level` in `{cross_source_with_subagent, cross_source_no_subagent, same_source_subagent}` (R1/R2/R6)
- `config/route-rules.json`: degradation rules present under `degradation` key

## 2. Verdict contract + pass-evidence
- `references/pass-evidence-contract.md`: defines `reviewSnapshot`, `riskDisposition`, `worktreeInventory` as the three required fields
- `scripts/verdict-core-hash.mjs`: `riskDisposition` is in the `SEMANTIC_KEYS` inclusion list (line 32), NOT in the exclusion list (`_execNonce`, `_runtimeConfig`, `subreviewerRuntimeReports`, `delegatedReviewBundle`, `worktreeInventory`)
- `standalone.sh`: pass-fields fail-fast enforcement at L229-255 — missing any of `reviewSnapshot`, `riskDisposition`, or `worktreeInventory` → `escalate_to_human` (exit 2)

## 3. Multi-lens coverage
- `subreviewers/`: 6 distinct subreviewer prompt files present (`evidence-freshness-auditor.md`, `mechanical-grep-auditor.md`, `required-skill-auditor.md`, `scope-boundary-auditor.md`, `source-manifest-auditor.md`, `threat-modeling-auditor.md`)
- `scripts/run-delegated-precheck.mjs`: invokes multiple subreviewer lenses via `inferAutomaticLensPlan` and `byLens` dispatch (threat-modeling-auditor, mechanical-grep-auditor, source-manifest-auditor, evidence-freshness-auditor, scope-boundary-auditor, required-skill-auditor)

## 4. Threat-auditor
- `subreviewers/threat-modeling-auditor.md`: file exists and non-empty (3 categories: forgery-bypass, proof-independence, schema-drift)
- `scripts/run-threat-auditor.mjs`: file exists and non-empty (deterministic oracle-acceptance harness)
- `scripts/run-delegated-precheck.mjs`: wires threat-modeling-auditor lens into subreviewer dispatch — findings flow through `subreviewerRuntimeReports[]` in the delegated review bundle
