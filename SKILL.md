---
name: 3rd-review
description: Independent cross-source code/document review dispatch. Use when a stage/phase completes and needs review, when the user asks to review code/a plan/a design, or when an agent must NOT self-review/self-approve and you need an independent (cross-source, e.g. codex/gemini) verdict with pass/revise/escalate gating.
---

# 3rd-review — review dispatch (thin shell)

> This file is the skeleton the main session reads. Execution detail used only by reviewers/scripts lives in `references/` — the main session does not read it; sub-agents/scripts load it on demand. Full index at the end.

## When to trigger

When a stage/phase completes and review is needed.

## What it does

Runs the whole dispatch chain: checkpoint_request → review-package construction (three source kinds + Delta Package) → independent reviewer verdict → JSON persisted → reviewer_output gate → stage_advance.

Both usage contexts share one review strategy and one set of decision scripts; only the environment difference is isolated into two thin entrypoints:
- **Inside agenthub (gated)**: the main agent is triggered via `checkpoint_request`, runs through `review-dispatch-adapter.sh`, persists into the task dir, and is checked by the gate.
- **Off-platform (standalone)**: a clean-room review of code/docs, no gate, no journal. Entrypoint `./standalone.sh`. Detail in `references/standalone-usage.md`, `references/work-dir-contract.md`.

## Routing (authoritative classifier is route-review.mjs; this section is the decision sequence)

The authoritative review-method `level` (cross-source R2/R1, same-source R6) is produced by the pure classifier `scripts/route-review.mjs` and consumed by `review-dispatch-adapter.sh`. Before dispatching any review, decide in three steps. The steps are orthogonal — entry does not imply method:

**Step 1 · Entry** (gated adapter or not):
- **Bound to a live gated task** (a reviewRequestId from `checkpoint_request` + this task's task-dir) → use the heavy entrypoint `review-dispatch-adapter.sh` (gated, gate-checked).
- **Unbound** → do not use the gated adapter. That is all it means — entry does not pick the review method (same/cross-source); see steps 2/3.
- Note: `standalone.sh`'s default runner delegates to the gated adapter, so it still requires a task-dir/reviewReqId; don't use it on unbound changes unless you inject a `--review-runner` that doesn't depend on gated identity.

**Step 2 · Environment** (any external CLI present):
- Probe two external CLIs: `command -v codex` and `command -v gemini` (or another cross-source tool).
- **Both fail** (`ENV_PROBE_RESULT=no_external_cli`) → downgrade to **R6 same-source clean sub-agent** (Agent tool, fresh independent context — satisfies hard rail #4).
- Either available → go to step 3.

**Step 3 · Content + progress** (cross-source R2/R1 vs R6):
- **Level is the classifier's authority; the shell does not restate thresholds.** Feed the **real diff / source files / review package** to `route-review.mjs` (or the adapter); it produces `RouteDecision.level` (R6/R2/R1) from content type + scope + risk keywords. Do not restate the medium/large line thresholds or escalation rules here — that is the code's job, and prose restating code inevitably drifts.
- **Input rule (the one thing the main agent must remember here)**: feed a real diff/source files, **not** a "review my XYZ plan" natural-language description — plain text is classified text-record/small and routes to R6. That is not a cross-source failure, it's wrong input. Docs-only/tiny/trivial changes *should* be R6; no cross-source overhead needed. **When calling `route-review.mjs` directly you must also pass the real `--diff-lines=N`** (default 0 → a code diff is judged trivial → R6); or go through the adapter/standalone entry, which counts lines for you — don't call the classifier bare and drop the line count.
- **Progress-driven downgrade** (multi-round): round one follows the classifier (medium-and-up is cross-source); later rounds' downgrade is decided authoritatively by `applyPostRoundDegradation` from the **prior round's finding count + whether any was blocking** (see `references/verdict-dispatch.md`). The shell does not restate the thresholds. Hard rails never downgrade (FR-REVIEW-004/005).

Thresholds and downgrade forms: `scripts/route-review.mjs`, `references/execution-steps.md`, `references/delta-package-rules.md` ("no-CLI downgrade form, FR-REVIEW-003"), `references/verdict-dispatch.md` ("dynamic escalation rules").

## Wiring precheck failure: tell "wrong path" from "missing argument" first

When the review infrastructure's **identity/wiring precheck** fails — signals like `requires --task-dir`, `missing reviewRequestId`, `unverifiable review identity`, `refusing to run` — decide which case it is. The two are handled oppositely:

- **Case A: unbound task ran through a gated entry** (no checkpoint_request, no task-dir, yet you called standalone/adapter's gated path) → "wrong entry chosen", **not a retryable review failure**. **Stop on first occurrence** and return to the three-step routing above (unbound → no adapter; method by env + content + progress: docs-only/tiny still R6, medium-and-up must be cross-source on round one). **Never** synthesize a temporary task-dir, fake a reviewRequestId, or wrap a fake-identity runner to get past the check — that wastes effort and breaks review-identity verifiability (the anti-forgery premise).
- **Case B: genuinely inside a live gated flow, just missing an argument** (there really is a checkpoint_request / this task's task-dir, you only omitted `--task-dir` etc.) → an ordinary argument bug; **supply the real arguments and retry** (real values, not synthesized). Don't switch paths.
- The test: **does the missing argument have a real source?** A real task-dir/checkpoint to fill = B, supply truth. None exists and you'd have to fake it = A, stop and switch paths.
- All of the above is distinct from "reviewer returned revise_required/escalate" — that is a real verdict after the review ran; this section is about a review that never started. Only a real verdict enters verdict dispatch.

## Heavy entrypoint (recommended, one-line dispatch)

The main agent dispatches a full review in one line; the adapter atomically does exec (provider command + AJV validation) → persist (write + report), exposing only `{verdict, reportPath, evidencePaths}`.

```bash
# Step A (foreground, seconds): prepare the prompt + result files.
PROMPT_FILE=$(mktemp /tmp/3rd-review-prompt-XXXXXX); echo "$PROMPT" > "$PROMPT_FILE"
RESULT_FILE=$(mktemp /tmp/3rd-review-result-XXXXXX.json)

# Step B (dispatch with run_in_background:true — MUST be this single bash command, no trailing command appended):
#   the verdict is written to RESULT_FILE; the adapter review sub-command's real exit code is this command's exit code.
bash {path-to}/review-dispatch-adapter.sh review \
  --prompt-file="$PROMPT_FILE" --result-file="$RESULT_FILE" \
  --checkpoint-id="{checkpoint-id}" --round="{round}" \
  --task-dir={TASK_DIR} --workflow={workflow-id} \
  --reviewer-role="reviewer" --reviewer-runtime-id="{runtime-id}" --reviewer-provider="{provider}"

# Step C (after the command exits and auto-wakes you, foreground): consume RESULT_FILE only after the three-condition check, then clean up PROMPT_FILE.
```

- Background hard rule: dispatch the review command with the Bash tool's `run_in_background: true` (detached, cross-turn, auto-wakes the main agent on exit). **That background Bash call must contain only the review command — no trailing command (`; rm` / `&& ...` / `| ...` / `find` etc.), and no `RESULT=$(...)` command-substitution capture** — otherwise task-notification reports the exit code of the trailing command (or the swallowed outer assignment) as 0, not the review command's real code, turning escalate (exit 2) into a false success. The verdict goes to `--result-file`. After exit, run the three-condition check: ① the process truly exited ② RESULT_FILE is complete and parseable (verdict/findings present) ③ exit code = 0 — all three before persist; any failure → re-run foreground with a long timeout (≥1500000ms). **The verdict is authoritative from RESULT_FILE; the exit code is only a secondary signal.** A passive `Command running in background` (kicked to background by the harness without you declaring it) is treated as a failure.
- On execution failure, output `{"verdict":"failed",...}` and exit 0 so the main flow isn't interrupted.
- Review-package construction, Source Manifest, Delta Package, parallel sub-reviewer precheck, prompt assembly: `references/delta-package-rules.md`, `references/execution-steps.md`, `references/reviewer-prompt-assembly.md`.

## Sub-agent dispatch

With no external CLI (R6 downgrade), review via a clean sub-agent: it runs in a fresh independent context (does not inherit main-session history), receives the full reviewer-contract + verifier prompt, does not relax the hard rails, and emits the same output format as the external-CLI path. Provenance enumeration and downgrade-form requirements: `references/reviewer-prompt-assembly.md`, `references/execution-steps.md`.

## Intake routing map (checkpoint-id prefix → required skills)

| checkpoint-id prefix | required skills |
|---|---|
| `design-review` | plan-ceo-review, review, plan-design-review |
| `plan-review` | speckit-analyze, plan-eng-review, review |
| `test-acceptance-review` | qa-only, verify-change |
| `intake-direction-review` | plan-ceo-review, review |
| `intake-detail-review` | review |

Verifier prompt/contract selection table and Design Sources required-reading table: `references/execution-steps.md`.

## Pass-evidence fields (a pass verdict must carry them)

A pass must include `reviewSnapshot[]` (objective, coverage-bearing), `riskDisposition[]` (subjective, never backfilled, fail-fast if missing), and `worktreeInventory` (objective). Minimum shapes: `reviewSnapshot[]` items carry `path/gitHead/mtime/hash`; `riskDisposition[]` items carry `risk/checkedSource/decision/whyNotBlocking`; `worktreeInventory` carries `included/unrelated/excluded`. **Full spec — required shapes in detail and the standalone-vs-gated backfill difference — lives in `references/pass-evidence-contract.md`; that file is authoritative.** All three sit outside the verdict-core-hash whitelist, so backfill doesn't break the `_execNonce` anti-forgery check.

## Escalation

Review rounds have no fixed cap; escalation is decided in the reviewer-skill layer, not by a workflow-engine counter. The same unresolved blocking finding (same file / same class / same core description) recurring up to a threshold → `escalate_to_human`, signalling a human is needed. Each round, find the root cause before fixing; switching review form does not relax the rails. Full dynamic escalation rules (exact thresholds, root-cause-first, form-switch constraints): `references/verdict-dispatch.md`.

## Hard rails (no form may bypass these)

1. Minimum regression coverage: each round covers ≥80% of changed lines across all changed files in the phase.
2. Mandatory full review of high-risk dimensions: high-risk parts get a complete review, never a downgraded sample.
3. Fall back to full scope on failure: if a reduced-scope review fails any rail → `fallback_full_scope` immediately.
4. Independence guarantee: the final verdict must come from an independent context; the main agent never self-reviews/self-approves.

Reduced-scope compensation, Delegated Trust priority, delegated-precheck mandate: `references/delta-package-rules.md`, `references/execution-steps.md`.

## Verdict dispatch (pass / revise_required / escalate_to_human)

- `pass` → `post_review_required`: do post-pass retention (host auto-writes feedback/summary journal) + the `post_review_pass` gate before `stage_advance`. A pass is not a completion state.
- `revise_required` → `review_intake_required`: enter the fix loop (receiving-code-review → review-intake → TDD re-collect → next round).
- `escalate_to_human` → stop, output the escalation reason, wait for a human.

Full dispatch steps, post-pass ordering, the fix loop's 8 gate checks, exec proof, reviewer verification gate: `references/verdict-dispatch.md`, `references/exec-proof.md`, `references/verifier-gate.md`.

## Red-flag self-check (STOP on sight)

A fast index of the hard-stops defined in the sections above — if any of these appears while dispatching/running a review, stop. (Most have actually happened. This is an aggregation entry, not a replacement for the detailed rules.)

- **Faking identity**: synthesizing a temp task-dir / faking a reviewRequestId / wrapping a fake-identity runner to pass an identity check (see "Wiring precheck failure").
- **Polluting the background command**: appending a trailing command (`; rm` / `&& ...` / `| ...` / `find`) or using `RESULT=$(...)` capture — swallows the real exit code, turns escalate (exit 2) into false success (see "Heavy entrypoint").
- **Bypassing the execution layer**: `--delegated-precheck=off` to skip the exec check / the main agent hand-writing review JSON to bypass the atomic persist chain (exec-proof.md, 2026-06-12 bypass incident).
- **Breaking independence**: the main agent self-reviewing / skipping the independent-context verdict (hard rail #4).
- **Treating pass as done**: a pass still needs post-pass retention + the `post_review_pass` gate before `stage_advance`; a pass must carry the three evidence fields, fail-fast if missing.
- **Reduced scope not falling back**: a reduced-scope review failing any rail → `fallback_full_scope` immediately; never pass via reduced scope.
- **Mis-downgrade via input/routing**: feeding only a "review my XYZ" text description instead of a real diff (false R6); defaulting an unbound task to R6 without probing the CLI (cross-source available but going same-source).

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
| `references/exec-proof.md` | exec proof (tamper-evident, `_execNonce` + reviewRecordHash) |
| `references/verdict-dispatch.md` | step-6 verdict dispatch + post-pass actions + dynamic escalation rules (thresholds, root-cause-first, hard-rail cross-refs) |
| `references/verifier-gate.md` | reviewer verification gate (anti-bypass, FR-REVIEW-012) |
| `references/pass-evidence-contract.md` | authoritative spec for the three pass-evidence fields + standalone-vs-gated backfill |
