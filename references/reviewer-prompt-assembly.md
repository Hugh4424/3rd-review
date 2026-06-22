# Step 4: Reviewer Independent Review — Prompt Assembly + Runtime Preferences + DISPATCH MODE OVERRIDE + Thick-Wrapper Invocation Surface

> This file is referenced by the 3rd-review SKILL.md thin shell. The main session does not read it; reviewers/scripts read it on demand.
>
> Note: `review-dispatch-adapter.sh` and `review-persist.sh` mentioned throughout are agenthub platform components (not present in the standalone repo); in standalone mode their role is filled by `./standalone.sh` + the injected `--review-runner`.

## provenance Enumeration Requirements (Output Contract)

The `provenance` field in the reviewer's output JSON MUST use the verdict schema enum values: `"single-context"` / `"independent-subagent"` / `"independent-session"`. When falling back to a clean sub-agent review due to no CLI, the sub-agent path MUST use `"independent-subagent"`; any value not in the enum will be rejected by schema validation. The complete behavioral constraints for fallback forms are in `references/delta-package-rules.md`, section "No-CLI Fallback Form (FR-REVIEW-003)".

### Step 4: Reviewer Independent Review

Assemble the prompt: Verifier Instructions (short entry point + path list) + Runtime Preferences (model/thinking-intensity config) + Inline Package (phase-scoped Design Sources) + Delta Package (diff + hunk context, not full large-file text) + Source Manifest + Current Worktree Inventory + Preflight Signals + Required Read Set + Standards Sources (path list) + reviewRequestId. Round 2+ additionally attaches the previous round's complete findings JSON for closure verification (see Delta Package rules).

**Every round is a complete, independent review**: Each round (including round 2+) is a COMPLETE, INDEPENDENT review of this checkpoint's full responsibility domain. The Delta Package replaces large file full-text inline with diff + hunk context: small files (≤24KB) may be inlined in full; large files (>80KB) are forbidden from default full-text inline — only diff + hunk context + Required Read Set are passed. This does not narrow the review scope — see Full-review rule below.

#### 4a. Runtime Preferences (Runtime Configuration)

Before writing to `PROMPT_FILE`, you must resolve the runtime configuration for this round and append the JSON summary to the prompt. Resolution priority:

1. Adapter explicit parameters: `--model` / `--effort` / `--config-file`
2. User config: `$AGENTHUB_REVIEW_DISPATCH_CONFIG` or `~/.agenthub/review-dispatch-config.json`
3. Repo temporary default config: `packages/core/agenthub/config/review-dispatch-default.json` (agenthub platform path; not in the standalone repo)

Resolution command:

```bash
RUNTIME_CONFIG_JSON=$(node scripts/resolve-review-runtime-config.mjs \
  --role=reviewer --round="<round>")
```

Append to the prompt:

```text
## Runtime Preferences
<RUNTIME_CONFIG_JSON>

Reviewer MUST use reviewer.model / reviewer.thinking_level as the requested reviewer runtime. If reviewer.model is empty, omit the model flag and let the system default apply.
review-dispatch-adapter MUST run delegated precheck before final reviewer execution.
Subreviewers MUST use subreviewer.model / subreviewer.thinking_level.
Do not ask the final reviewer to produce runtime metadata fields. The adapter
will attach authoritative subreviewerRuntimeReports, delegatedReviewBundle,
and recommendedFinalReadSet after the final verdict JSON is returned.
The final reviewer MUST produce finalVerifierReadSet itself as the actually
inspected source targets for this verdict.
```

Append the DISPATCH MODE OVERRIDE at the end of the prompt. **This section overrides all file-write, index-append, and skill-invocation rules in the verifier prompts above**:

```
## DISPATCH MODE OVERRIDE
You are running as a reviewer via 3rd-review.
The following overrides ALL conflicting rules from the verifier prompts above:

- Return ONLY valid JSON matching verdict.schema.json. No other output. Do NOT output markdown.
- Do NOT write any files. Do NOT create verifier-reports/ files.
- Do NOT append to verifier-report-index.md.
- Do NOT append to reviews.jsonl.
- Ignore all "输出落盘规则" / "输出铁律" sections. Persistence is handled by 3rd-review after you return JSON.
- Exception: you MAY create temporary files under /tmp only for reviewer-side sub-agent execution, and MUST remove them before returning the final JSON.

**Language rule (CRITICAL)**: ALL JSON string values MUST be in English only. No Chinese characters, no Unicode quotes, no non-ASCII in any JSON field. This is a machine-parsing requirement — Chinese characters inside JSON strings break the pipeline. The markdown report will be generated separately with Chinese localization for human readability.

**Required skills ARE available** in your skills directory. Execute them in read-only verifier mode. Depending on checkpoint kind these include: `plan-ceo-review`, `plan-design-review`, `speckit-analyze`, `plan-eng-review`, `qa-only`, `verify-change`, `review` (see the checkpoint→required-skills mapping in `references/execution-steps.md`).
  - Try the Skill tool first when available.
  - If Skill tool execution fails, read the skill's SKILL.md from the first existing path: `~/.codex/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`.
  - Apply the lens's checklist/dimensions to the review sources.
  - Record key findings in skillResults with status="executed" and evidence strings (in English). If SKILL.md fallback was used, set mode to include `skill-file fallback`. Evidence MUST contain three elements: (1) where executed (session location or SKILL.md fallback path); (2) specific input/checkpoint checked; (3) conclusion/finding. Hollow summaries ("ran skill, no issues") are rejected (FR-REVIEW-006/007).
  - If a skill is not applicable to this review, set status="not_applicable" with reason in evidence

**Review rules**: (1) Read >=80% of modified code lines from each changed file. (2) Every finding must cite file + line + code snippet. (3) Blocking findings must describe the online-triggered symptom. (4) First round must list ALL blocking issues at once — Surface every blocking finding in round 1; do NOT hold back issues for later rounds. (5) When uncertain, bias towards revise_required. (6) EVERY finding MUST carry a `blockerClass` field, one of: `delivery_quality` (real delivery-quality defect, MAY be blocking) / `process_evidence` (process/evidence/format issue, MUST NOT be blocking — downgrade to important/minor) / `output_contract` (output-contract issue, severity per impact). Missing `blockerClass` makes the report fail-fast (FR-CLASS-001). `process_evidence` + `blocking` is a forbidden combination (FR-CLASS-002). (7) In round 2+, any NEW blocking finding that did not appear in the previous round MUST include a `missedInPreviousRoundReason` field explaining why it was missed (e.g., source not read, scope misunderstanding, new evidence surfaced). Omitting this field on a new-in-round-N blocking finding is itself a protocol violation.

**Delegated review is mandatory**: The prompt includes a `Delegated Review Bundle` generated by `review-dispatch-adapter.sh` before you were started. You MUST read the bundle, independently verify high-risk items, and use it as evidence input only. You remain the only final verdict owner. If the bundle is missing, return `escalate_to_human` with a finding explaining that delegated precheck was not executed.

**Runtime configuration**: The adapter records authoritative `_delegatedPrecheck`, `subreviewerRuntimeReports`, `delegatedReviewBundle`, and `recommendedFinalReadSet` after the reviewer returns. The final reviewer MUST NOT write, summarize, replace, or invent these runtime metadata fields. The final reviewer MUST output `finalVerifierReadSet` with the source targets it actually inspected.

**Pass evidence binding**: A pass MUST include `reviewSnapshot[]` for every reviewed file (`path`, `gitHead`, `mtime`, `hash`), `riskDisposition[]` for every delegated high risk (`risk`, `checkedSource`, `decision`, `whyNotBlocking`), and `worktreeInventory` with `included`, `unrelated`, and `excluded` path arrays. Current Worktree Inventory cannot be summary-only: list dirty unrelated/excluded paths and why they do not affect this checkpoint.

Pass-field semantics (maintainer note — NOT injected to the reviewer): The reviewer is required to PRODUCE all three pass fields (see the binding line above); persist-side autofill is a host safety-net, never a license for the reviewer to skip them. The three fields differ in nature and in how persist treats a missing field on a pass:

- `reviewSnapshot[]` — OBJECTIVE, but coverage-bearing. If a pass omits it, persist autofills ONLY when the reviewer's `finalVerifierReadSet` exists, and the snapshot path-set is derived FROM that readset (it is a coverage attestation — the path-set can never be invented from git status); per-path `gitHead`/`mtime`/`hash` are computed from disk. With no readset the field is NOT autofilled — persist fail-fasts naming `reviewSnapshot` (no empty skeleton).
- `worktreeInventory` — OBJECTIVE, not a coverage claim. If a pass omits it, persist autofills it from `git status` (git is a legitimate source here, unlike for the snapshot path-set).
- `riskDisposition[]` — SUBJECTIVE. Persist NEVER autofills it; a pass that omits it fail-fasts naming `riskDisposition`.

All three fields sit OUTSIDE the verdict-core-hash whitelist, so persist autofill does not break the `_execNonce` anti-forgery check.

**Full-review rule (CRITICAL — applies to EVERY round, including round 2+)**: Each round is a COMPLETE, INDEPENDENT review of this checkpoint's full responsibility SCOPE, NOT a narrow re-check. The scope invariant is absolute and is never narrowed by any round, any prior finding, or the Delegated Trust exception below. "Full review" means full-SCOPE coverage at a tiered READING DEPTH (see the Delegated Trust exception) — it does NOT mean inline-reading every byte of every file, and it does NOT require the prompt to inline every source file. You MUST cover the inline package, every Required Read Set item, and any Source Manifest file needed to judge correctness, at the reading depth its risk tier demands. Even on later rounds you MUST surface ANY issue you find — new or old. Verifying that prior-round findings are closed is an ADDITIONAL check layered on top of the full-scope review; it must NEVER replace or narrow it. A round-2 pass with zero findings is only valid if the full responsibility scope was genuinely reviewed at the correct depth and no issue was found. If any required source cannot be read, return escalate_to_human.

**Delegated Trust exception (READING-EFFORT optimization WITHIN full-scope review, NOT a scope exception)**: This exception tiers only the READING DEPTH per block — it operates inside the Full-review rule above and never narrows its scope invariant. Apply these tiers across the full scope:

| Risk tier | Block trigger | Required reading depth |
|---|---|---|
| 高危 / high-risk | touched by a high-risk item, candidate finding, forbidden/core/scope-boundary rule, or your own suspicion | MUST read in FULL — never sampled |
| 中危 / medium-risk | in scope, no high-risk trigger | browse / skim |
| 低危 / low-risk | in the bundle's `coverageAccepted` (already covered by subreviewers) | MAY apply base-verifier sampling fallback (sample a fraction; escalate to full re-read on ANY sampling mismatch) |

The sampling fallback ONLY reduces redundant reading effort on 低危 coverageAccepted sources — it does NOT narrow the round's full responsibility scope and does NOT exempt any 高危 block. When in doubt about a block's tier, treat it as 高危 and read in full. A pass still requires that the full responsibility scope was genuinely reviewed at these depths.

**No spawning narrowed subtasks**: Do NOT spawn sub-agents with task descriptions that pre-state "the revision summary" or limit scope to "verify whether prior finding X is closed". Any sub-agent you spawn must receive the checkpoint responsibility scope, Source Manifest, Required Read Set, and full-review mandate, not a narrowed confirmation task.

**Non-code review skill execution**: For design/plan/test-acceptance reviews, the reviewer MUST attempt to execute required skills. The execution order: (1) Try `Skill("<name>")` to invoke the skill directly. (2) If that fails (common in headless/read-only environments where skills require AskUserQuestion or file output), fall back by reading the skill's SKILL.md from the first existing path: `~/.codex/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`. Extract the review dimensions/lens from SKILL.md and apply those dimensions independently to the review sources. (3) Record results in `skillResults`: status=`executed` if either direct Skill execution or SKILL.md fallback succeeded, mode includes `skill-file fallback` when fallback was used, and status=`failed` only if both approaches failed. This fallback pattern works for ANY skill without per-skill configuration. Skill results are input to your review, not final verdict — only findings matching the checkpoint's reviewer contract blocking list can be marked blocking; non-matching findings MUST be downgraded to important/minor. If a required skill is unavailable and its SKILL.md cannot be read at all → escalate_to_human.

Output format (English-only JSON):
{"reviewRequestId":"<id>","verdict":"pass|revise_required|escalate_to_human","reviewSnapshot":[{"path":"...","gitHead":"...","mtime":"...","hash":"..."}],"riskDisposition":[{"risk":"...","checkedSource":"...","decision":"not_blocking|blocking","whyNotBlocking":"..."}],"worktreeInventory":{"included":[{"path":"...","reason":"..."}],"unrelated":[{"path":"...","reason":"..."}],"excluded":[{"path":"...","reason":"..."}]},"skillResults":[...],"verificationResults":[{"command":"<command or evidence read>","exitCode":0,"evidence":"<path or host fact>"}],"findings":[{"severity":"blocking|important|minor","blockerClass":"delivery_quality|process_evidence|output_contract","file":"...","line":0,"issue":"...","impact":"...","recommendation":"..."}]}
```

### Thick-Wrapper Invocation Surface (Recommended Entry Point)

The orchestrator launches a complete review with a single line — one entry point, atomically completing review execution and persistence internally, exposing only `verdict` + `reportPath` + `evidencePaths` to the caller. The caller does not need to be aware of internal steps or manually execute them separately.

```bash
# Step A (foreground, seconds): prepare prompt + result files
PROMPT_FILE=$(mktemp /tmp/3rd-review-prompt-XXXXXX); echo "$PROMPT" > "$PROMPT_FILE"
RESULT_FILE=$(mktemp /tmp/3rd-review-result-XXXXXX.json)

# Step B (launch with run_in_background:true — MUST contain only this one command;
#   do NOT chain trailing commands, do NOT capture with RESULT=$(...),
#   as these mask the real exit code — see SKILL.md red-flag checklist / execution-steps.md):
bash <path-to>/review-dispatch-adapter.sh review \
  --prompt-file="$PROMPT_FILE" --result-file="$RESULT_FILE" \
  --checkpoint-id="<checkpoint-id>" --round="<round>" \
  --task-dir=<TASK_DIR> --workflow=<workflow-id> \
  --reviewer-role="reviewer" --reviewer-runtime-id="<runtime-id>" --reviewer-provider="<provider>"

# Step C (foreground, after command exits): read verdict from RESULT_FILE only after all three conditions pass, then clean up PROMPT_FILE
VERDICT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).verdict)" "$RESULT_FILE")
REPORT_PATH=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).reportPath)" "$RESULT_FILE")
rm -f "$PROMPT_FILE"
```

- `review-dispatch-adapter.sh review` → atomic wrapper: exec (provider command + AJV validation) → persist (write to disk + generate report) → output `{"verdict":"...","reportPath":"...","evidencePaths":[...]}` JSON
- Internal step surface (already handled by the thick wrapper; only call directly for diagnostics): `exec` uses `--result-file` to capture reviewer stdout to a result file (`RESULT_FILE=$(mktemp ...)`), then `review-persist.sh` reads that RESULT_FILE to write to disk and generate a report. The thick wrapper only exposes `--prompt-file` externally; `--result-file` / `RESULT_FILE` are managed internally by the adapter.
- On execution failure, outputs `{"verdict":"failed","checkpoint":"...","round":N,"error":"..."}` and exits 0, so the main flow is not interrupted
- Timeout/retry is handled internally by the adapter (`REVIEW_TIMEOUT_SECONDS` env var can override, default 600s); the outer host Bash tool timeout is recommended at 1500000ms

**Key change**: review-persist.sh no longer automatically executes stage_advance. After verdict routing, the main agent executes subsequent actions:

- reviewer_output(verdict=pass) → state.currentStatus = `post_review_required`
- reviewer_output(verdict=revise_required) → state.currentStatus = `review_intake_required`
- reviewer_output(verdict=escalate_to_human) → state.currentStatus = `escalated`

`pass` only means the review passed; it is not a completion state. After pass, the system must first be in `post_review_required`, complete post-pass retention and `post_review_pass`, before `stage_advance` can be called.

3. Review implementation metadata persistence path contract:

- Markdown: `<task-dir>/reports/<checkpoint-id>-<N>.md`
- Raw JSON: `<task-dir>/reviews/<checkpoint-id>/round-<N>.json` (contains `_codexMeta`)
- Metrics JSON: `<task-dir>/reviews/<checkpoint-id>/round-<N>.metrics.json`

Rendering rules are enforced by `render-views.ts`; when `subreviewer_meta` is not recorded, the report displays "Sub-agent details: not recorded" — do not fabricate split values.

---
