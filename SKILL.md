---
name: 3rd-review
description: Review code, plans, or designs with an independent verdict. Use when the user asks for a code/plan/design review, or when an agent must NOT self-review/self-approve. Results in pass/revise/escalate outcomes.
triggers:
  - 审查
  - review
  - 帮我审查一下
  - third-party review
  - 代码审查
mode: lightweight
---

# 3rd-review — review engine (thin shell)

## V3 migration guard

V3 的唯一新入口是 `scripts/3rd-review.mjs`。Phase 0 只冻结通用请求/receipt 协议并提供 `--adapter=mock` 集成基线，**不能用于真实审查**。协议、nonce、private receipt 和不得删除的失败语义见 [`docs/v3-protocol-freeze.md`](./docs/v3-protocol-freeze.md)。

现有 `standalone.sh` 和 `scripts/run-heterologous-review.mjs` 仅为 V2 兼容面：只维护现有回归行为，不再向其中新增 provider、认证、超时、session 或报告功能。真实 V3 provider dispatch 在后续 phase 才切换；切换前 wh-review 继续使用兼容面，禁止两套 runner 并行扩展。

> This file is the skeleton the main session reads. Execution detail used only by reviewers/scripts lives in `references/` — the main session does not read it; sub-agents/scripts load it on demand. Full index at the end.

## Triggers

Registered as a global skill. These phrases are the 触发词 (trigger words) that route here: `审查`, `review`, `帮我审查一下`, `third-party review`, `代码审查`. On match, invoke `standalone.sh` with a caller-assembled `{mode, contract, materials}` input. The frontmatter `triggers`/`mode` keys mirror this for symlinked registration.

## What it does — pure engine interface

3rd-review is a stateless review engine. It has **zero knowledge of workflow stages or review-round history** — that bookkeeping belongs entirely to the caller (e.g. wh-review's `round-state.mjs`). This engine only ever judges one submitted package and returns one verdict.

- **Input**: a structured triple `{mode, contract, materials}` — `mode` (`full`/`incremental`/`same-source`), `contract` (the review contract content/path this call is judged against), `materials` (the assembled review package the caller wants judged). Passed via `--diff=<file>` (a file holding this payload) and `--output=<file>`.
- **Output**: single-round JSON `{verdict, findings, actual_mode}` written to `--output`. `verdict` ∈ `pass` / `revise_required` / `escalate_to_human`. `findings[]` items carry `severity`/`file`/`line`/`issue`/`recommendation`. `actual_mode` reports which of full/incremental/same-source was actually executed.
- **CLI contract**: only `--diff=<file> --output=<file>` (plus `--env-strip-check` for diagnostics) are accepted. Legacy `--stage`/`--round`/`--checkpoint` flags are rejected outright with a non-zero exit and an explicit error — never silently ignored.
- Internally dispatches a heterologous review: route classification (provider/environment availability, R1/R2/R6) → independent reviewer execution via `run-heterologous-review.mjs` (cross-engine through `omc ask`, excluding the current host to guarantee independence) → single verdict JSON written to `--output`.
- Must run synchronous foreground — never `run_in_background` / `nohup`. The caller blocks on this call to get the verdict; backgrounding it loses the exit code and collapses the pass/revise/escalate distinction.

## Routing (authoritative classifier: `scripts/route-review.mjs`)

Provider/environment availability decides the route — not stage or round:

- **Step 1 · Environment**: probe `command -v codex` and `command -v gemini`. Both fail → same-source clean sub-agent with a fresh independent context — an explicit no-external-CLI downgrade, recorded as `downgraded`. This is a degraded fallback, NOT full cross-source independence; use only when no external CLI exists. Either available → step 2.
- **Step 2 · Content**: feed a real diff / source files / review package, not a "review my XYZ" text description — plain text is classified as a trivial input and misrouted away from a full review, which is a routing mistake, not a genuine cross-source failure. When calling `route-review.mjs` directly, pass the real `--diff-lines=N` (default 0 → a real code diff gets misjudged as trivial); `standalone.sh` counts lines for you.
- **Step 3 · Entry point**: `standalone.sh` (default) invokes `run-heterologous-review.mjs` via `omc ask`. Or set `THIRD_REVIEW_RUNNER` / `--review-runner=<cmd>`.

## Standalone entrypoint

```bash
bash {path-to}/standalone.sh --diff=<file> --output=<file> [--skip-manifest] [--output-root=<dir>]
```

Handles input guard, route classification, reviewer dispatch, and verdict rendering in one call. Exit codes: 0=pass, 1=revise_required, 2=escalate_to_human. `--skip-manifest` skips the snapshot-manifest anti-forgery sidecar and tags the verdict `anti-forgery: lightweight (no-manifest)` — a manifest-evidence toggle, unrelated to stage/round; omit it when the caller wants the full evidence chain.

## Sub-agent dispatch

With no external CLI available (the R6 downgrade), review via a clean sub-agent: it runs in a fresh independent context (does not inherit main-session history), receives the full reviewer-contract + verifier prompt, does not relax the hard rails, and emits the same `{verdict, findings, actual_mode}` shape as the external-CLI path. Provenance enumeration and downgrade-form requirements: `references/reviewer-prompt-assembly.md`, `references/execution-steps.md`.

## Pass-evidence fields (a pass verdict must carry them)

A pass must include `reviewSnapshot[]` (objective, coverage-bearing), `riskDisposition[]` (subjective, never backfilled, fail-fast if missing), and `worktreeInventory` (objective). Minimum shapes: `reviewSnapshot[]` items carry `path/gitHead/mtime/hash`; `riskDisposition[]` items carry `risk/checkedSource/decision/whyNotBlocking`; `worktreeInventory` carries `included/unrelated/excluded`. **Full spec — required shapes in detail and the standalone-vs-gated backfill difference — lives in `references/pass-evidence-contract.md`; that file is authoritative.** All three sit outside the verdict-core-hash whitelist, so backfill doesn't break the snapshot-manifest content-hash binding.

## Ironclad hard rails — no bypass, no relaxation, no form may dodge

1. Minimum regression coverage: each review call covers ≥80% of the changed lines across all changed files in its input.
2. Mandatory full review of high-risk dimensions: high-risk parts get a complete review, never a downgraded sample.
3. Fall back to full scope on failure: if a reduced-scope review fails any rail → `fallback_full_scope` immediately.
4. Independence guarantee: the final verdict must come from an independent context; the caller never self-reviews/self-approves.

Reduced-scope compensation, Delegated Trust priority, delegated-precheck mandate: `references/delta-package-rules.md`, `references/execution-steps.md`.

## Verdict semantics (pass / revise_required / escalate_to_human)

- `pass` → this call's material meets the contract; the caller decides what happens next (e.g. advance, or await human confirmation).
- `revise_required` → this call's material has blocking findings; the caller decides whether/how to resubmit for another round.
- `escalate_to_human` → the engine judges this call unresolvable on its own; the caller stops, surfaces the reason, and waits for a human.

**Round-over-round bookkeeping is not this engine's job.** Repeated-finding tracking, downgrade-on-recurrence, escalation-after-N-rounds, and the fix loop (receiving-code-review → fix → re-review) all live entirely in the caller (wh-review's `round-state.mjs`). This engine only ever returns one round's verdict from one submitted package — it does not remember prior calls.

## Red-flag self-check (STOP on sight)

A fast index of the hard-stops defined in the sections above — if any of these appears while dispatching/running a review, stop. (Most have actually happened. This is an aggregation entry, not a replacement for the detailed rules.)

- **Breaking independence**: self-reviewing / skipping the independent-context verdict (hard rail #4).
- **Treating pass as done**: a pass must carry the three evidence fields, fail-fast if missing.
- **Reduced scope not falling back**: a reduced-scope review failing any rail → `fallback_full_scope` immediately; never pass via reduced scope.
- **Mis-downgrade via input/routing**: feeding only a "review my XYZ" text description instead of a real diff (false downgrade); defaulting to same-source without probing the CLI (cross-source available but going same-source anyway).
- **Running in background**: launching standalone.sh via `run_in_background` or `nohup` — review must be synchronous foreground.
- **Reintroducing stage/round knowledge**: adding back `--stage`/`--round`/`--checkpoint` flags, or any stage-name/round-number-aware branching, into this engine's entry points. That bookkeeping belongs to the caller, permanently.

---

## references/ index

The main session reads only this thin shell. The resources below are loaded on demand by sub-agents/scripts/reviewers (never enter the main-session context).

| references file | content |
|---|---|
| `references/standalone-usage.md` | off-platform usage (D12) |
| `references/work-dir-contract.md` | general contract: the work-dir abstraction |
| `references/input-guard.md` | input guard (D17) |
| `references/delta-package-rules.md` | Delta Package construction + reduced-scope rail compensation + two-layer structure |
| `references/execution-steps.md` | execution steps 0–4: required-skills precheck / Design Sources / Worktree Inventory / Host-Verified Facts / parallel sub-reviewer precheck |
| `references/reviewer-prompt-assembly.md` | step-4 prompt assembly + Runtime Preferences + DISPATCH MODE OVERRIDE (incl. provenance enumeration and downgrade-form requirements) |
| `references/verdict-dispatch.md` | step-6 verdict dispatch mechanics within a single call (root-cause-first, hard-rail cross-refs) |
| `references/pass-evidence-contract.md` | authoritative spec for the three pass-evidence fields + standalone-vs-gated backfill |
