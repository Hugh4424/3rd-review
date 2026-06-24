# Execution Steps 0–3.5: Pre-checks / Review Package Construction / Host-Verified Facts / Sub-reviewer Parallel Pre-review

> This file is referenced by the 3rd-review SKILL.md thin shell. The main session does not read it; reviewers/scripts read it on demand.

## Execution Steps

### Step 0: Pre-checks

#### 0a. Required Skills Availability Pre-check

**Goal**: Ensure the reviewer can access all skills required for the review.

Determine the required skills from `checkpoint-id`:

| checkpoint-id prefix | required skills |
|---|---|
| `design-review` | plan-ceo-review, review, plan-design-review |
| `plan-review` | speckit-analyze, plan-eng-review, review |
| `test-acceptance-review` | qa-only, verify-change |
| `intake-direction-review` | plan-ceo-review, review |
| `intake-detail-review` | review |

For each required skill: the adapter automatically handles detection and symlinking (FR-PORT-001, follow symlinks).

- Skill present → continue
- Skill missing → `BLOCKED`, stop; user choices: A) install the skill  B) skip (risk: review may be incomplete)  C) pause

Once all required skills are available, proceed to the next step.

**Note**: CLI availability is probed uniformly in Step A (env_probe). When the reviewer CLI is missing, do not silently continue — fall back to a clean sub-agent review per FR-REVIEW-003 (see "Degraded Mode Definitions" above). The adapter handles skills-directory sync (symlinks); the caller does not need to run this manually.

### Step 1: Pre-submission Self-check

Executed only for `code-review-*` checkpoints. Other checkpoints skip this step.

```bash
bash packages/core/agenthub/harness/gate.sh phase_pre_review {workflow-id} --task-dir={TASK_DIR} --phase={N}
```
*(agenthub platform path; not in the standalone repo)*

exit ≠ 0 → stop, fix per the remediation guide.

### Step 2: checkpoint_request (obtain reviewRequestId)

```bash
bash packages/core/agenthub/harness/gate.sh checkpoint_request {workflow-id} --task-dir={TASK_DIR} --checkpoint-id={checkpoint-id} --round={N}
```
*(agenthub platform path; not in the standalone repo)*

Extract reviewRequestId from output (`checkpoint_request: {reviewRequestId}`). The `{checkpoint-id}` for the Apply phase must be `code-review-phase-N`; do not use `apply` or the reviewRequestId. When `apply/currentPhase=N` and the parameter is omitted, gate automatically binds `code-review-phase-N`.

### Step 3: Construct the Review Package

Review package = Inline Package + Delta Package + Source Manifest + Current Worktree Inventory + Required Read Set + Standards Sources (path list) + Verifier Instructions (short entry point + path list).

#### 3a. Delta Package

Construct from artifacts and `git diff` per the Delta Package rules. For round 2+, quickly index `reviews.jsonl` by `findingsSummary`, then read the full raw JSON from `reviews/{checkpoint}/round-{round}.json` using checkpoint + round.

#### 3b. Design Sources (phase-scoped inline + full-source manifest; missing required → escalate_to_human)

| File | design-review | plan-review | code-review | test-acceptance-review |
|------|:--:|:--:|:--:|:--:|
| `specs/{changeId}/spec.md` | required | required | required | required |
| `specs/{changeId}/plan.md` | — | required | required | required |
| `specs/{changeId}/tasks.md` | — | required | required | required |
| `artifacts/decision-log.md` | **required** | **required** | optional | optional |
| Extra design docs declared in tasks.md `design_docs` | if declared → required | if declared → required | if declared → required | if declared → required |

- `—` = file not yet generated at this stage; skip check
- optional = include if present; warn if absent

**Inline rules**: design/plan may inline the full reviewed document. If the three documents total >50 KB, switch to key-structure inline + Source Manifest. code-review must apply phase-level trimming: extract phase N from checkpoint-id; inline the `Phase N` section of `tasks.md`; extract `FR-*` numbers from that phase's tasks and inline the corresponding FR sections of `spec.md`; inline the `Phase N` section of `plan.md`; add full paths of `spec.md` / `plan.md` / `tasks.md` to the Source Manifest. If reliable trimming is not possible → fall back to full design sources; if still unreadable → `escalate_to_human`.

```text
## Source Manifest
- specs/{changeId}/{spec,plan,tasks}.md — full source, read on demand
- {changed-file} — full source, read on demand; inline package contains diff/hunk context
```

#### 3b-1. Current Worktree Inventory (machine-generated, authoritative)

`Source Manifest` cannot rely on hand-written groupings to represent the current worktree. 3rd-review must run from the repo root:

```bash
git status --porcelain=v1
```

and generate a `Current Worktree Inventory`. Every active changed path must be listed with its exact repo-relative path; this includes modified, added, deleted, renamed, staged, unstaged, and untracked files. Renames must record both the old path and the new path. Abbreviated paths such as `verifiers/...` or `.claude/skills/...` are forbidden in place of real paths.

Each row in the Inventory must include:

| Field | Description |
|---|---|
| status | Status from `git status --porcelain=v1` |
| path | exact repo-relative path |
| classification | `design artifact` / `Story 1B scope` / `review-dispatch precondition-fix` / `source-derived-layout precondition-fix` / `setup` / `cleanup` / `unrelated / exclude before review` |
| reason | Why this file belongs to this classification |

The Inventory must also provide aggregate counts: `statusLineCount`, `uniquePathCount`, `renameOldNewCount`, `untrackedCount`, `deletedCount`. This allows the reviewer to distinguish between status-line count, unique-path count, rename old/new expansion count, and untracked-file count.

Hand-written Source Manifest entries may only supplement; they cannot override the machine Inventory. If any changed path is unclassified, it must be exposed as high-risk before the final reviewer is launched. For a formal review submission, fix the classification first and retry.

#### 3c. Standards Sources (pass a **path list**, do not inject full text)

The reviewer runs inside the reviewer runtime and can read files itself. Standards documents are commonly long (root CLAUDE.md + package-level CLAUDE.md + workflow docs can easily exceed tens of thousands of characters). **Injecting full text bloats the prompt and dilutes review focus.** Instead, provide a path list in the prompt and let the reviewer self-read on demand:

| File | Level |
|------|------|
| Root `CLAUDE.md` | required (list path) |
| Package-level `CLAUDE.md` nearest to changed files (including `packages/core/agenthub/CLAUDE.md` *(agenthub platform path; not in the standalone repo)*) | required (list path) |
| `packages/core/agenthub/workflows/vibecoding/contract.md` *(agenthub platform path; not in the standalone repo)* | required (list path) |
| Root `AGENTS.md` | optional (list path if present) |

- In the prompt, provide the path list under a "Standards Sources — self-read the following files on demand" section, with a one-line description of each file's purpose.
- Missing core file (path does not exist) → escalate_to_human
- Forbidden-files rules are covered by the "Forbidden core files" section of root CLAUDE.md; the reviewer obtains them naturally when reading CLAUDE.md.

#### 3d. Verifier Instructions (short entry point + path list)

Extract the review kind prefix from `--checkpoint-id` (exact, e.g. `code-review-phase-5`) and select the corresponding verifier. All gate, journal, and raw JSON paths use the same exact `{checkpoint-id}`; do not abbreviate to the review kind:

| checkpoint-id prefix | verifier prompt | verifier contract |
|---|---|---|
| `code-review` | `verifiers/vibecoding/code-reviewer.md` | `verifiers/vibecoding/code-reviewer-contract.md` |
| `design` | `verifiers/vibecoding/design-reviewer.md` | `verifiers/vibecoding/design-reviewer-contract.md` |
| `plan` | `verifiers/vibecoding/plan-reviewer.md` | `verifiers/vibecoding/plan-reviewer-contract.md` |
| `test-acceptance` | `verifiers/vibecoding/test-acceptance-reviewer.md` | `verifiers/vibecoding/test-acceptance-reviewer-contract.md` |
| `intake-direction-review` | `verifiers/vibecoding/intake-direction-reviewer.md` | `verifiers/vibecoding/intake-reviewer-contract.md` |
| `intake-detail-review` | `verifiers/vibecoding/intake-detail-reviewer.md` | `verifiers/vibecoding/intake-reviewer-contract.md` |

The prompt inlines only the short entry point; the three full verifier files are listed in the Verifier Instruction Manifest: `verifiers/base-verifier.md`, `verifiers/vibecoding/{verifier-contract}`, `verifiers/vibecoding/{verifier-prompt}`. The short entry point must include: review kind, reviewRequestId, verdict schema output requirements, required skills, the rule that blocking findings may only come from contract rules, and the requirement to read the Required Read Set. If any verifier file is missing → `escalate_to_human`. Fall back to inlining all three originals only when the reviewer runtime cannot read repo files, and record a `fallbackCostNote`.

#### 3e. Required Read Set (Final Verifier mandatory read set)

The Required Read Set is drawn from: code-review changed hunks, boundary/forbidden/core files, deterministic preflight signals, the `recommendedFinalReadSet` from the reviewer-side delegated bundle, and changed-function/hunk/symbol regions of large files (>80 KB). The prompt must list each item's `path`, `lines/range`, and `reason`. If any required item cannot be read → `escalate_to_human`.

### Step 3.1: Host-Verified Facts (environment-sensitive hard facts; run before precheck)

**Purpose**: Move operations that are unreliable inside the reviewer runtime (running tsx, validating evidence provenance) to the host for execution. The reviewer only reads the results and does not re-run them.

**Hard facts only, no judgments**:

| Fact | Source | Injection point |
|------|------|---------|
| repoRoot | `state.json` or `git rev-parse --show-toplevel` | `run-delegated-precheck.mjs` `precomputedEvidence()` |
| git HEAD | `git rev-parse HEAD` | same |
| reviewRequestId | extracted from prompt | same |
| evidence file metadata | path/hash/cwd/git_sha/exit_code/timestamp for each `apply/evidence/*.json` | same |
| 4-tuple (repoRoot, taskDir, git HEAD, reviewRequestId) | composed from the above | same; written to bundle.topRisks if mismatch |
| phase verification command + exit code | tasks.md Verify section | manually constructed on host, injected into prompt Delta Package section |

Each fact carries a `source` (which command/file it came from) and a `collectedAt` (ISO timestamp).

**Reviewer contract**: the verifier contract specifies that when Host-Verified Facts are present, do not re-run the evidence command — read-plausibility check is sufficient (**this exemption covers only the re-running of host-verified evidence commands; it does not exempt the requirement to read ≥80% of changed lines**). Contradiction → `escalate_to_human` (fail-closed). See `packages/core/agenthub/workflows/vibecoding/code-reviewer-contract.md` *(agenthub platform path; not in the standalone repo)* and `test-acceptance-reviewer-contract.md` *(agenthub platform path; not in the standalone repo)*.

### Step 3.5: Sub-reviewer Parallel Pre-review + Bundle Generation (mandatory)

Delegated precheck must run by default. The sole exception is a route-driven R2 downgrade (`cross_source_no_subagent`): that tier is determined by the route layer; the final reviewer then audits the full diff at full effort without sub-reviewer lens budget (persisted as `reviewMode=lightweight-review`, constrained by a hash-bound `precheckDecisionSource=route`). **Manual `--delegated-precheck=off` remains forbidden** — it is a bypass path sealed in Phase 6c, permitted only in adapter unit tests or manual diagnostics; it must not be manually disabled in a formal 3rd-review. Aside from route-driven R2, there is no "direct review mode". `review-dispatch-adapter.sh exec --role=reviewer` *(agenthub platform path; not in the standalone repo)* automatically plans lenses before launching the final reviewer, starts `--role=subreviewer` sub-reviewers in parallel, and injects the merged `Delegated Review Bundle` into the final reviewer prompt.

Built-in lens pool (auto-selected by `scripts/run-delegated-precheck.mjs` based on current-round signals):

`source-manifest-auditor` / `required-skill-auditor` / `scope-boundary-auditor` / `evidence-freshness-auditor` / `mechanical-grep-auditor` / `acceptance-evidence-auditor` / `verifier-closure-auditor` / `browser-qa-auditor` / `plan-traceability-auditor` / `design-intent-auditor`

Trigger logic is in `scripts/run-delegated-precheck.mjs` (checkpoint-id / review kind / package signals are strong signals; ordinary file names, FR numbers, etc. are weak signals only). Inapplicable lenses must return `skipped/not_applicable`; low-information output is fail-closed.

Execution entry point:

**Background execution hard rules (proactive background + auto-wake + three-condition verification)**:
- When calling the `review-dispatch-adapter.sh exec` *(agenthub platform path; not in the standalone repo)* below (or the `review` atomic sub-command), use the Bash tool's `run_in_background: true` to proactively launch in the background. The command runs detached and continues across turns; when it exits, the harness automatically re-wakes the main agent — no user intervention needed, no front-end polling by the main agent.
- **A background Bash call must contain only the review command and nothing else**: do not append any trailing commands (`; rm ...` / `&& ...` / `| ...` / `find ...` / `echo ...` etc.), and do not use `RESULT=$(...)` command substitution to capture output. Reason — the process exit code reported in a task-notification is the exit code of the **last command** in that Bash call; if trailing commands are appended, the reported code is that of the trailing command (e.g. `rm`/`find`, which always exit 0); if `$()` capture is used, the subshell exit code is discarded by bash and the outer assignment always yields 0. Both patterns mask the review command's real exit 2 (escalate) as exit 0. Review results must be written to `--result-file`; preparation/cleanup steps (mktemp, removing prompt files) go in foreground steps after the wake-up, never in the same line as the background review command.
- After the command exits, apply three-condition hard verification; proceed only when all three are satisfied; if any fails, re-run in the foreground with a long timeout (≥1500000 ms):
  1. The background process truly exited (a real exit status was obtained — not "still running", not killed);
  2. RESULT_FILE is complete and parseable (`jq .` passes, key fields such as verdict/findings are present and non-empty, not truncated);
  3. exit code = 0 (the full chain of delegated precheck + final reviewer + retry + (if using `review`) persist succeeded).
- Verification is based on on-disk artifacts (RESULT_FILE + exit code), not on the background-completion notification itself: the notification only determines *when to look*; verification determines *whether it succeeded*. **Among the three conditions, verdict is determined by RESULT_FILE content; exit code is an auxiliary signal only** (because exit code may be distorted by the compound-statement trap described above, while RESULT_FILE is written directly by the reviewer). This preserves the intent of "do not pretend the review finished based on a notification alone", while not discarding work that has already completed.
- If the command was **passively** pushed to the background by the harness (i.e. `Command running in background` appeared without an explicit `run_in_background` declaration), treat this as a failure for the current round and re-run proactively in the background.

```bash
bash packages/core/agenthub/harness/review-dispatch-adapter.sh exec \
  --prompt-file="$PROMPT_FILE" --result-file="$RESULT_FILE" \
  --checkpoint-id="{checkpoint-id}" --round="{round}" \
  --role=reviewer \
  --delegated-precheck=required
```
*(agenthub platform path; not in the standalone repo)*

Key anti-forgery invariants inside the adapter (see `scripts/run-delegated-precheck.mjs` for details):

- **finalVerifierReadSet** must be output by the final reviewer itself (the actual reviewed source targets); the adapter must not fabricate it from `recommendedFinalReadSet`
- `_delegatedPrecheck.plannerDecisions` must record the source, trigger reason, and signals for each lens
- `subreviewerRuntimeReports` must separately record `requestedModel`/`requestedEffort` (request parameters) and `sessionModel`/`sessionEffort` (actual session records); they must not be conflated
- A blocking finding must have its file/line/snippet verified to exist in the original source before being written to disk

The review package may declare additional lenses via the `Delegated Lens Plan` JSON; prefer letting Source Manifest / Required Read Set / evidence / contract signals drive the planner automatically, and only hand-write lenses when automatic selection is insufficient. Do not hard-code new stages in the adapter or persist logic.

`--delegated-precheck=off` is permitted only in adapter unit tests or manual diagnostics; it must not be disabled in a formal 3rd-review. When precheck fails, it must be fail-closed — the final reviewer must not be launched.
