---
name: 3rd-review
description: Universal third-party code/document review dispatch. Use when the user asks to review code/a plan/a design, or when an agent must NOT self-review/self-approve and you need an independent (cross-source, e.g. codex/gemini) verdict with pass/revise/escalate outcomes.
---

# 3rd-review — review dispatch (thin shell)

> This file is the skeleton the main session reads. Execution detail used only by reviewers/scripts lives in `references/` — the main session does not read it; sub-agents/scripts load it on demand. Full index at the end.

## 触发词（全局 Claude skill）

本技能注册为全局 Claude skill，输入以下任意触发词自动选中该技能：

- `审查`
- `review`
- `帮我审查一下`
- `third-party review`
- `代码审查`

当用户在对话中输入上述触发词时，Claude Code 自动路由到本技能，调用 `standalone.sh --skip-manifest` 执行异源审查。

## When to trigger

When the user asks for an independent review of code, a plan, a design, or any output that must not be self-reviewed/self-approved.

## What it does

Dispatches a full heterologous review chain: input ingestion → route classification (R1/R2/R6) → independent reviewer execution via `run-heterologous-review.mjs` (cross-engine through `omc ask` backend) → verdict JSON persisted → report rendered. The default reviewer uses a cross-source provider (codex/gemini/etc.), excluding the current host to guarantee independence — hard rail #4.

## 两种模式

**轻量模式（lightweight / chat）**
- 触发方式：用户在对话中输入触发词，或调用 `standalone.sh --skip-manifest`
- 不生成 snapshot-manifest 侧车（content-binding hash）
- 裁决中注入 `anti-forgery: lightweight (no-manifest)`
- 适用场景：快速 chat 内审查，不需 manifest 证据链

**阶段门模式（stage-gate）**
- 触发方式：工作流阶段完成时显式调用完整审查，不传 `--skip-manifest`
- 生成完整 snapshot-manifest 侧车（content-binding hash，FR-FORGE-001）
- 消费者验证：由完整模式调用方验证裁决完整性
- 适用场景：正式阶段门禁审查，需完整证据链

> **重要：审查必须前台同步执行，禁止 run_in_background / nohup。** 审查是阻塞操作——调用方需等待裁决结果才能决定下一步（pass/revise/escalate）。后台化会丢失退出码和裁决信号，导致 pass/revise/escalate 三态不可区分。

## Routing (authoritative classifier is route-review.mjs; this section is the decision sequence)

The authoritative review-method `level` (cross-source R2/R1, same-source R6) is produced by the pure classifier `scripts/route-review.mjs`. Before dispatching any review, decide in three steps:

**Step 1 · Environment** (any external CLI present):
- Probe two external CLIs: `command -v codex` and `command -v gemini` (or another cross-source tool).
- **Both fail** (`ENV_PROBE_RESULT=no_external_cli`) → downgrade to **R6 same-source clean sub-agent** (Agent tool, fresh independent context — satisfies hard rail #4).
- Either available → go to step 2.

**Step 2 · Content + progress** (cross-source R2/R1 vs R6):
- **Level is the classifier's authority; the shell does not restate thresholds.** Feed the **real diff / source files / review package** to `route-review.mjs`; it produces `RouteDecision.level` (R6/R2/R1) from content type + scope + risk keywords. Do not restate the medium/large line thresholds or escalation rules here — that is the code's job, and prose restating code inevitably drifts.
- **Input rule (the one thing the main agent must remember here)**: feed a real diff/source files, **not** a "review my XYZ plan" natural-language description — plain text is classified text-record/small and routes to R6. That is not a cross-source failure, it's wrong input. Docs-only/tiny/trivial changes *should* be R6; no cross-source overhead needed. **When calling `route-review.mjs` directly you must also pass the real `--diff-lines=N`** (default 0 → a code diff is judged trivial → R6); or go through the standalone entry, which counts lines for you — don't call the classifier bare and drop the line count.
- **Progress-driven downgrade** (multi-round): round one follows the classifier (medium-and-up is cross-source); later rounds' downgrade is decided authoritatively by `applyPostRoundDegradation` from the **prior round's finding count + whether any was blocking** (see `references/verdict-dispatch.md`). The shell does not restate the thresholds. Hard rails never downgrade (FR-REVIEW-004/005).

**Step 3 · Entry point**:
- **standalone.sh** (default, universal): invokes `run-heterologous-review.mjs` — cross-engine review via `omc ask` backend, excluding the current host. No agenthub dependency.
- **Custom runner**: set `THIRD_REVIEW_RUNNER` env var or pass `--review-runner=<cmd>` to standalone.sh.

Thresholds and downgrade forms: `scripts/route-review.mjs`, `references/execution-steps.md`, `references/delta-package-rules.md` ("no-CLI downgrade form, FR-REVIEW-003"), `references/verdict-dispatch.md` ("dynamic escalation rules").

## Standalone entrypoint

```bash
# Lightweight (chat) mode — skip manifest, fast:
bash {path-to}/standalone.sh --skip-manifest --input=<diff-or-file> [--output-root=<dir>]

# Stage-gate mode — full manifest + evidence:
bash {path-to}/standalone.sh --input=<diff-or-file> [--output-root=<dir>]
```

The standalone entry auto-selects the heterologous reviewer (`run-heterologous-review.mjs`) by default. It handles input guard, task directory creation, route classification, reviewer dispatch, and verdict rendering in one call. Exit codes: 0=pass, 1=revise_required, 2=escalate_to_human.

## Sub-agent dispatch

With no external CLI (R6 downgrade), review via a clean sub-agent: it runs in a fresh independent context (does not inherit main-session history), receives the full reviewer-contract + verifier prompt, does not relax the hard rails, and emits the same output format as the external-CLI path. Provenance enumeration and downgrade-form requirements: `references/reviewer-prompt-assembly.md`, `references/execution-steps.md`.

## Pass-evidence fields (a pass verdict must carry them)

A pass must include `reviewSnapshot[]` (objective, coverage-bearing), `riskDisposition[]` (subjective, never backfilled, fail-fast if missing), and `worktreeInventory` (objective). Minimum shapes: `reviewSnapshot[]` items carry `path/gitHead/mtime/hash`; `riskDisposition[]` items carry `risk/checkedSource/decision/whyNotBlocking`; `worktreeInventory` carries `included/unrelated/excluded`. **Full spec — required shapes in detail and the standalone-vs-gated backfill difference — lives in `references/pass-evidence-contract.md`; that file is authoritative.** All three sit outside the verdict-core-hash whitelist, so backfill doesn't break the snapshot-manifest content-hash binding.

## Escalation

Review rounds have no fixed cap; escalation is decided in the reviewer-skill layer, not by a workflow-engine counter. The same unresolved blocking finding (same file / same class / same core description) recurring up to a threshold → `escalate_to_human`, signalling a human is needed. Each round, find the root cause before fixing; switching review form does not relax the rails. Full dynamic escalation rules (exact thresholds, root-cause-first, form-switch constraints): `references/verdict-dispatch.md`.

## Hard rails (no form may bypass these)

1. Minimum regression coverage: each round covers ≥80% of changed lines across all changed files in the phase.
2. Mandatory full review of high-risk dimensions: high-risk parts get a complete review, never a downgraded sample.
3. Fall back to full scope on failure: if a reduced-scope review fails any rail → `fallback_full_scope` immediately.
4. Independence guarantee: the final verdict must come from an independent context; the main agent never self-reviews/self-approves.

Reduced-scope compensation, Delegated Trust priority, delegated-precheck mandate: `references/delta-package-rules.md`, `references/execution-steps.md`.

## Verdict dispatch (pass / revise_required / escalate_to_human)

- `pass` → the change is ready to proceed; verify pass-evidence fields are present.
- `revise_required` → enter the fix loop (receiving-code-review → fix → re-review).
- `escalate_to_human` → stop, output the escalation reason, wait for a human.

Full dispatch steps, the fix loop: `references/verdict-dispatch.md`.

## Red-flag self-check (STOP on sight)

A fast index of the hard-stops defined in the sections above — if any of these appears while dispatching/running a review, stop. (Most have actually happened. This is an aggregation entry, not a replacement for the detailed rules.)

- **Breaking independence**: the main agent self-reviewing / skipping the independent-context verdict (hard rail #4).
- **Treating pass as done**: a pass must carry the three evidence fields, fail-fast if missing.
- **Reduced scope not falling back**: a reduced-scope review failing any rail → `fallback_full_scope` immediately; never pass via reduced scope.
- **Mis-downgrade via input/routing**: feeding only a "review my XYZ" text description instead of a real diff (false R6); defaulting to R6 without probing the CLI (cross-source available but going same-source).
- **Running in background**: launching standalone.sh via `run_in_background` or `nohup` — review must be synchronous foreground (see "两种模式" note).

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
| `references/verdict-dispatch.md` | step-6 verdict dispatch + post-pass actions + dynamic escalation rules (thresholds, root-cause-first, hard-rail cross-refs) |
| `references/pass-evidence-contract.md` | authoritative spec for the three pass-evidence fields + standalone-vs-gated backfill |
