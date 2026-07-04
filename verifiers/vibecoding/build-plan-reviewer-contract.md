# Plan Review Contract

> This file defines the inspection dimensions for the plan-reviewer. Findings outside this contract may only be marked `minor`, never `blocking`.

## Three-Axis Review

Every round must cover all three axes — none may be skipped:

| Axis | Meaning | Reference source |
|------|---------|-----------------|
| **Traceability** | Whether spec FRs are fully mapped to tasks and verifications | spec.md, plan.md, tasks.md, speckit-analyze |
| **Executability** | Whether phase granularity, ordering, dependencies, and risks are executable | tasks.md, plan-eng-review |
| **Verification** | Whether tests, fresh evidence, gates, and approvals are objective | tasks.md, review skill output, contract.md |

## Required Skill Execution

The reviewer must directly invoke:

- `speckit-analyze`: cross-artifact consistency, covering duplication, ambiguity, underspecification, constitution alignment, coverage gaps, inconsistency.
- `plan-eng-review`: engineering plan review, covering architecture, data flow, boundaries, failure modes, test strategy, performance, worktree/parallelism strategy.
- `review`: independent re-review of diff/scope drift, TODO/stale documentation, structural risks, adversarial checks.

If a required skill is unavailable and the SKILL.md file is unreadable, cannot be executed in report-only lens, or the output lacks key conclusions → `escalate_to_human`. pass/revise output must include a top-level `skillResults` that records executed / unavailable / failed for each skill.

**Skill execution fallback rule**: The reviewer must first attempt to invoke required skills via the Skill tool. If the Skill tool fails in a headless/read-only environment, the reviewer must fall back — directly Read that skill's SKILL.md file, extract the review dimensions and checklists from it, and apply them independently to the plan sources. When fallback succeeds, record `status=executed` and note `skill-file fallback` in the `mode` or `evidence` field.

**Three-element execution summary requirement (FR-REVIEW-006)**: The `evidence` field of each required skill must contain three elements: (1) **where it was executed** — session location / record path; (2) **specific inputs / checkpoints** — what was actually checked (e.g., specific file paths, check dimensions); (3) **conclusion** — what was found. Placeholder text such as "executed", "passed", or any content-free filler is prohibited.

**Minimum substantive content threshold (FR-REVIEW-007)**: Criteria for identifying hollow summaries. Any of the following conditions constitutes a hollow summary, and the reviewer must downgrade to `failed`:
- evidence contains only status words, no execution location
- evidence lacks specific checkpoints or input descriptions
- evidence is missing a conclusion
- Hollow example: `{"status":"executed","evidence":"ran speckit-analyze, plan looks fine"}` — missing execution location, no specific dimensions
- Compliant example: `{"status":"executed","evidence":"(1) skill tool in this session; (2) checked task breakdown for T001-T008 against FR mapping in spec.md; (3) all tasks have FR reference, T005 scope boundary clear"}`
Judgment does not rely on automated machine verification of execution location paths — it is performed by manual reviewer inspection; path accessibility is not required.

## General Principles

The review focus is whether the plan can be executed stably, not whether the checklist looks complete. Answer these 6 questions first:

1. **Is phase division reasonable** — Can each phase be completed independently by one agent within a reasonable session?
2. **Is the dependency chain correct** — Are there reverse dependencies? Do contract/schema precede engine/adapter/UI?
3. **Is the file list precise** — Are there wildcards, conditional descriptions, or reference-style entries?
4. **Are risks identified** — Does the plan underestimate failure modes, rollback, performance, or testing costs?
5. **Is Verify objective** — Can each step produce a clear pass/fail, rather than "looks normal"?
6. **Is FR coverage end-to-end** — Does every spec FR have a task, and can every task's Verify prove the FR is implemented?

## Incremental Review Rules

Round 1: Full review, produce findings across all dimensions in this contract.

Round 2+:

1. Verify each prior-round blocking item one by one; not resolved → blocking.
2. Review only files changed in this round and affected sources.
3. If RuntimeAdapter / checkpoint / workflow boundaries, forbidden files, or cross-package interfaces are touched → perform a full re-review of that module.
4. New blocking findings may only come from changes in this round, problems impossible to detect in prior rounds, or architecture/boundary touches; all other late findings are marked `minor`.
5. Each round is an independent session reviewing only the review package.
6. When `verdict=pass` in round 2+, the `resolutionSummary` must close each prior-round blocking item one by one: state the original finding, the fixed file/line number, and why it no longer blocks. Missing closure summary → review is insufficient; should be `revise_required` or re-reviewed.

## Blocking / Non-Blocking Classification

**Blocking (must produce revise_required)**:

- `speckit-analyze` reports CRITICAL/HIGH that affects execution: constitution MUST conflict, core FR has no task, artifacts contradict each other, acceptance criteria are untestable.
- `plan-eng-review` reports architecture/dependency/test/failure mode is not executable and unaddressed.
- Constitution gate not checked line by line or items are missing.
- Task does not reference an FR number, or the FR → task → verify chain is broken.
- Phase granularity too coarse (e.g., "implement all features"), a single phase spans too many layers, or exceeds a reasonable session.
- Depends On is inverted, circular dependency exists, or [P] parallel markers conflict with dependencies.
- Verify is a subjective judgment; lacks typecheck/test/build or a clear alternative check.
- Verify command is a "fake command": exit code swallowed by a pipe (e.g., `pnpm test | tail` used as a pass/fail criterion), invented flags (e.g., `--kind`/`--cmd`), grep count only checks `:0$`, md5/sha256 records only after without before, `require('xxx.ts')`.
- A task modifies an existing script/CLI/journal event/schema but the plan has not registered its current signature under a "Existing Interface Signature Anchor" (SIG-xxx), or the signature is marked "to be confirmed at apply time".
- Upstream merge safety assessment is incomplete, or forbidden files are not explained.
- Governance change is missing a sync matrix (7 fixed categories each individually judged; marked "changed" with no corresponding Task → blocking).
- UI change is missing design package/UI contract/affected_contract_element_ids, or describes "restore the design mockup" instead of contract elements — blocking when there is no verifiable UI goal at all.
- Plan hardcodes `vibecoding` into the platform, or adds an unapproved fallback, legacy adapter, compatibility layer, or template marketplace.
- Acceptance criteria verify only code, not behavior: acceptance criteria check only code structure/existence/compilation, without covering runtime behavior verification — reviewer must mark blocking. Pure documentation/configuration phases are exempt.
- plan pass is treated as human approval, or STOP mechanism between phases is missing.
- **Concept drift [codex ③]**: plan/tasks introduce new patterns, state machines, entities, fallbacks, or adapters that cannot be traced back to spec/decision-log. A full requirements re-review is not needed; only a concept drift scan is required.
- **Incomplete file/code impact coverage (FR-IMPACT-002/004)**: The file/code impact coverage in the plan does not cover every impacted feature listed in the spec's "Business Impact Scope" section, or delete/merge/rename changes are missing a reverse-reference scan (grep of all repo references not listed in the change surface) — any omission → blocking. The reviewer must independently verify: if the spec's business impact lists N items, the plan file list must account for each one (changed/deleted/tested). This is the mandatory lever against plans underestimating change surface (e.g., T018 missing ~13 files); pass is not accepted until full coverage is achieved.
- **yagni-level over-design**: The plan adds a concept/field/type/abstraction/dependency that cannot be mapped back to any FR / verification / governance requirement, or builds a single-use abstraction layer or scaffolding for an uncovered requirement, and simplifying it does not affect delivery → revise_required, with the removable items and an alternative given.
- **KISS deletes a red-line**: The review suggests deleting a non-simplifiable red-line (trust-boundary input validation, auth/permission/multi-tenant isolation, data-loss-preventing error handling, security/privacy, UI accessibility, existing gate/evidence/test constraints) — suggesting deletion of these safeguards itself is blocking.

**Non-blocking (should produce pass; may mark important/minor)**:

- Phase granularity could be merged but is still executable.
- Risk descriptions could be more specific.
- Reuse-priority matrix entries are somewhat general.
- UI details could be more precise but do not affect executable acceptance.
- Phase six-section is incomplete (missing a minor subsection) but can still be executed independently.
- Code-change phase does not have test-first as the first item, but the overall test strategy is clear.
- File paths are not precise enough but the implementer can locate them.
- Frontend change visual contract 6-dimension details are incomplete, but a verifiable UI goal declaration exists.

## Inspection Dimensions

| Dimension | Verification method |
|-----------|-------------------|
| Required Skills executed | Check speckit-analyze/plan-eng-review/review output; unable to execute required skill → escalate |
| Cross-artifact consistency | Compare against speckit-analyze duplication/ambiguity/underspecification/coverage/inconsistency |
| Constitution gate | grep Constitution Check table, no unchecked items; constitution MUST conflict → automatic blocking |
| FR reference completeness | Every task in tasks.md references an FR; every FR has at least one task |
| FR→task→verify | Every task's Verify can prove the corresponding FR is implemented |
| Phase six-section format | Every phase contains Goal/Files/Tasks/Verify/Knowledge/STOP |
| test-first ordering | First item in code phases is a failing test; docs-only phases explicitly exempt |
| Dependency graph | Extract Depends On table, check ordering, cycles, [P] conflicts |
| Phase granularity | Check whether one agent can complete independently within a reasonable session |
| Execution ordering | contract/schema → engine → adapter → UI/integration; high-risk logic tested first |
| Precise file paths | Wildcards, vague paths, reference-style entries prohibited |
| Fake command check | Verify/gate_cmd: no pipe-swallowed exit codes, no invented flags, grep counts bidirectional, md5 records before/after, no require .ts |
| Interface signature anchors | Tasks modifying existing scripts/CLI/events/schemas have registered SIG-xxx current signatures in the plan, with no "to be confirmed at apply time" |
| Upstream merge safety | plan.md must state whether forbidden files and cross-package interfaces are touched |
| Governance sync | Check governance file matrix with explanation of changed/unchanged + reason for each category |
| Knowledge/Checkpoint | Each phase updates progress.md, apply/phase-N.md, verifier reports; final test/close artifacts are planned |
| Verification plan | Includes project-appropriate test/typecheck/build; prompt/docs-only phases have alternative checks |
| UI design contract | affected_contract_element_ids, ui-contract.json back-link, contract elements rather than soft descriptions |
| Visual contract 6 dimensions | Font, spacing, color, interaction states, responsive, dark mode each present |
| Reuse-priority matrix | Reuse existing / adapt existing / must add new; prefer existing UI/view packages already in the project under review |
| Approval boundary | plan pass does not equal approval; human approval must be awaited before apply |
| Original requirements resolved line by line (FR-ACCEPT-003) | Cross-reference the original requirements ledger/decision-log and **verify each original requirement one by one** to confirm it is **fully resolved** in the plan (has a corresponding phase/task landing, not merely mentioned); any requirement with no destination or not verified → blocking |
| Four-category standards individually checkable (D7/D10, FR-REVIEW-005) | Delivery/exception/test/code four-category standards must exist as **hard line items that the reviewer can check off one by one**, without opening separate major sections for each. See the table below for each item |
| File/code impact coverage rate (D12, FR-IMPACT-002/004) | Cross-reference every impacted feature in the spec's "Business Impact Scope" section and **verify one by one** whether the plan's file/code impact coverage accounts for it (changed/deleted/tested); delete/merge/rename changes must include reverse-reference scan results. Any omission → blocking |
| Over-design review (KISS) | Use five tags to surface simplifiable spots: `delete` (dead code / things no requirement asked for) / `stdlib` (reinventing standard-library wheels) / `native` (pulling a third-party dep where a platform-native feature would do) / `yagni` (single-use abstractions, scaffolding "for later", fields/params/config not covered by any FR) / `shrink` (verbose phrasing that could be shorter). Verify one by one whether each newly added **concept/field/API/public type/cross-module function/dependency** maps back to some FR or verification/governance requirement; flag any that does not. Local implementation helpers only need to belong to a task, not be traced per-function to an FR. If already lean, explicitly clear it ("lean enough, executable") rather than nitpicking. When a reasonable estimate is possible, give a net line-count delta; if it cannot be estimated, omit it |
| On-demand section review rule | The review core is **whether the invariant is satisfied, not whether a section title is present**. N/A judgments must be cross-referenced against the spec's Business Impact Scope, decision-log, code reverse-reference scan, and the FR→task→verify chain. Marking N/A when the invariant is actually triggered → blocking; a missing section whose invariant is already covered in another section → not blocking. A repo-touching change that marks the evidence contract / verification strategy as N/A → blocking |

## Four-Category Standards Inspection Dimensions (D7/D10: Hard Line Items Checkable One by One)

> Delivery/exception/test/code four-category standards do not each get a separate major section. The valid core = making done / boundaries / tests / code references into **hard line items that the reviewer can check off one by one**. Each item below has a pass/fail criterion; the reviewer checks off each one, and any unsatisfied hard item → blocking.

| Category | Hard line items (individually checkable) | pass/fail criterion |
|----------|------------------------------------------|---------------------|
| **Delivery standard (done)** | Each phase's Goal states a checkable definition of completion (which files/behaviors are produced, not a vague "implement feature" description) | Goal contains specific verifiable outputs that can be checked one by one against the phase end state to judge done; writing only "complete X feature" with no checkable outputs → blocking |
| **Exception standard (boundaries)** | The plan explicitly lists failure/boundary/out-of-scope handling for this change (what is not done, how errors are surfaced, rollback boundaries) | Key failure paths have corresponding handling and are verifiable; missing boundary declaration or only happy path → blocking |
| **Test standard (dual-column runnable commands)** | Test standards are expressed as the plan's **dual-column runnable commands** (gate_cmd for machine pass/fail judgment + display_cmd for human-readable summary), treating fake green (D8) | See "Fake Command Check Rules" below; gate_cmd exit code swallowed / invented flag / one-directional grep → blocking |
| **Code standard (reference existing specs)** | Only **reference existing CLAUDE.md / lint rules**, do not establish new code standards; explicitly state that **lint errors are hard gates, not warnings** | Plan references the project CLAUDE.md engineering hard rules and declares lint errors as hard gates; establishing a new code style standard or treating lint errors as warnings → blocking |

## Dependency Graph Validation Rules

Must check the Depends On table in tasks.md:

- A depended-upon task appears after the task that depends on it → blocking.
- Backend contract/API phases must precede UI consumption phases.
- Circular dependency → blocking.
- Tasks marked [P] must not have dependency chains.

## UI and Visual Contract Rules

Required checks for frontend changes:

- plan.md defines 6 dimensions for each page: font allows only specified tokens, 4px grid and gap tokens, OKLCh semantic tokens, hover/focus/active/disabled + 150ms ease-out, breakpoints, `.dark` support.
- Layout framework checks for Shell/Sidebar/PageHeader, etc.: layout fidelity: Sidebar width, content area rounded/margin, collapse behavior, navigation highlight.
- Each UI task is annotated with `affected_contract_element_ids` linking back to `ui-contract.json`.
- When modifying existing UI, state whether existing contract elements are affected, and whether re-extraction and diff are needed.

## Governance Sync Rules

When modifying workflows, agent prompts, or governance rules, the plan must individually judge each of the 7 fixed categories (each marked "changed/unchanged + reason"; if marked "changed", a corresponding Task ID must exist):

- Project rules (CLAUDE.md / AGENTS.md / sub-package CLAUDE.md)
- Workflow definitions (stage prompts / *.workflow.ts)
- Reviewer contract (base-verifier / reviewer prompt / review contract)
- Schema (journal event / checkpoint / *.schema.json)
- Runtime config (.claude/settings.json / engine config)
- Knowledge/doc (docs/WORKFLOW.md / constitution.md / Knowledge rules)
- Automation gates / CI / hooks (.github/workflows / pre-commit / reserved-slugs generator / gate scripts)

Missing an entire category, or marked "changed" with no corresponding Task → blocking.

## Fake Command Check Rules

> The current engine only validates the command/exit_code of RED/GREEN evidence; it does not recognize the gate_cmd/display_cmd separation in the plan. Therefore, "verifying whether verification commands are trustworthy" is enforced manually at this review stage.

Verify every Verify / gate_cmd in plan.md and tasks.md one by one:

1. **Exit code intact**: Prohibit `... | tail`, `| head`, etc. from swallowing the tested command's exit code and using it as a pass/fail criterion; when a pipe is necessary, `set -o pipefail` must be used.
2. **Interface is real**: Flags/subcommands in the command must actually exist; invented ones (e.g., `--kind`, `--cmd`) are prohibited. When in doubt, the plan must provide the CLI's help/signature source.
3. **Assertions are bidirectional**: grep count assertions must not only match `:0$` (a single-file return is a bare number without a colon); md5/sha256 comparisons must record before first, then after.
4. **Correct test method**: Test TS with vitest; `require('xxx.ts')` is prohibited.
5. **gate and display separated**: `tail`/`grep`/`jq`-type commands may only appear in display_cmd (human-readable summary); they must not serve as the pass/fail criterion for gate_cmd.

Quick scan (manual grep assist — hits must be individually confirmed as to whether they are used as a criterion):
`grep -nE 'tail -[0-9]|--kind|--cmd|require\(.*\.ts' plan.md tasks.md`

Hit and used as a pass/fail criterion → blocking.

## Verification Methods

1. **Skill cross-reference**: Verify one by one whether speckit-analyze/plan-eng-review/review findings are reflected in the verdict; required skill not actually invoked → escalate.
2. **grep verification**: FR references, phase six-section, test-first, Governance matrix, visual contract 6 dimensions.
3. **Read files**: Completely Read spec.md, plan.md, tasks.md, progress.md to judge execution ordering and scope.
4. **Path check**: `ls` each path or verify against repo root; vague paths are prohibited.
5. **Dependency check**: Parse the Depends On table, verify ordering, cycles, [P].

## Same-Finding Two-Round Escalation Rule (FR-REV-001)

When the same blocking finding remains unclosed for 2 consecutive rounds, the finding must include:

1. Root cause.
2. Scan scope.
3. Counterexample matrix.
4. Closure checklist.

Still unclosed after round 3 → `escalate_to_human`.

## Revision Log

After receiving `revise_required` and before initiating the next review round, the main agent must append-only record: failure root cause, modified files, modification summary, verification commands and results. The reviewer reads only, does not write; missing revision log is treated as missing evidence.
