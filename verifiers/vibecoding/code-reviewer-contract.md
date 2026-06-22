# Code Review Contract

> This file defines the inspection dimensions for the code-reviewer. Findings outside this contract may only be marked `minor`, never `blocking`.

## Three-Axis Review

Every review round must cover all three axes without exception:

| Axis | Meaning | Reference Source |
|----|------|--------|
| **Spec** | Does the implementation conform to the design documents? | Design Sources (spec.md / plan.md / tasks.md / design docs) |
| **Standards** | Does the implementation conform to repository conventions? | Standards Sources (CLAUDE.md / package-level CLAUDE.md / contract.md) |
| **Structural Quality** | Does the implementation make the codebase harder to maintain? | Code diff + Structural Quality Gate (see below) |

## General Principles

The review focus is on code behavior and quality, not evidence formatting. Ask 6 questions:
1. **Is it correct?** — Are there logic bugs? Are there missing cases in state transitions?
2. **Is it in scope?** — Does the diff stay within the Files allowlist? Were any forbidden files touched?
3. **Is testing sufficient?** — Do new features have behavioral tests? Are failure cases covered?
4. **Is the evidence real?** — Are the exit_code/timestamp/provenance in apply/evidence/phase-N-RED/GREEN.json from a live run in the current session?
5. **Are there side effects?** — Are there unintended impacts along the change path?
6. **Is the design correct?** — Does the implementation align with Design Sources? Check each key design decision for the current phase against spec.md/plan.md/tasks.md/design docs line by line. Agent type, tool invocation method, and data flow path must match the design documents.

**Already automated**: Evidence existence (gate.sh phase_pre_review (agenthub platform path; not in the standalone repo) checks RED/GREEN file presence and content quality).
**Not automated**: The Files allowlist is enforced by guard.sh (agenthub platform path; not in the standalone repo) (PreToolUse hook) blocking dangerous file edits, but it does not verify that the diff scope is consistent with tasks.md — the reviewer must still validate diff scope.

## Incremental Review Rules

Round 1: Full review, produce findings across all dimensions defined in this contract.

Round 2 onwards:
1. **Verify prior round first**: Check every item in the previous round's Required Revisions. Any unresolved item → blocking.
2. **Incremental scan**: Only review files changed in this round (git diff --name-only). Unchanged files are not re-reviewed.
3. **Regression check**: Run git diff --stat. If this round's changes touch any of the following modules → perform a full review of that module:
   - RuntimeAdapter / checkpoint / workflow boundaries
   - Files on the forbidden files list
   - Cross-package interface changes
4. **New finding restrictions**: In round 2+, new blocking findings may only come from:
   a) New problems introduced by this round's changes
   b) Problems that were impossible to detect in the prior round
   c) Architecture boundary violations
   All other new findings must be marked minor and must not block pass.
5. **Independent session per round**: Each review round runs in an independent session/sub-agent and receives only the delta package.

## Blocking / Non-Blocking Classification

**Blocking (must produce revise_required)**:
- Functional errors (logic bugs, incorrect state transitions, missing cases, swallowed errors, partial writes, race conditions)
- Test failures (contract tests failing, GREEN evidence not genuine)
- Out-of-scope changes (touching forbidden files, package boundary violations, diff exceeds Files allowlist without a `precondition-fix` label)
- Missing critical evidence (no RED raw output, no GREEN raw output, cannot determine whether functionality is valid)
- Required review discipline not executed (less than 80% of modified files read, findings lack file/line references)
- FR items assigned to the current phase not genuinely implemented (task checked off but only the file exists, no behavioral evidence or test coverage)

**Non-blocking (should produce pass)**:
- Report format/readability (review summary wording too long, markdown formatting issues)
- Evidence completeness (RED/GREEN includes full group vs. only a single test, file paths are relative instead of absolute)
- workflow-issues.jsonl entries missing
- close/summary.md statistics discrepancy or number inconsistency
- Unrelated minor suggestions (code style preferences, non-binding architectural suggestions)

## Inspection Dimensions

| Dimension | Verification Method |
|------|---------|
| Spec — Design document alignment | Validate each key design decision for the current phase against Design Sources line by line. Agent type / tool invocation method / data flow path must match. Any deviation → blocking |
| Standards — Repository conventions | Check against Standards Sources (root CLAUDE.md, package-level CLAUDE.md, contract.md): ① Are any forbidden files touched? ② Is business logic leaking into shared/general modules? ③ Do naming, paths, and package boundaries conform to CLAUDE.md conventions? |
| Current phase delivery completeness | Verify all tasks in tasks.md for the current phase are checked off, and that the Files list covers the actual diff |
| Tests passing | Run the project's test suite (e.g. `pnpm test` or equivalent for the project under review) and verify output |
| RED/GREEN authenticity | Check apply/evidence/phase-N-RED.json/stdout/stderr and the corresponding GREEN capture evidence files (gate has verified provenance) |
| No shell diagnostics | Verify that script output does not contain bash errors such as `integer expression expected` |
| Diff scope consistency | Check that `git diff --name-only` is broadly consistent with the Files list in tasks.md |
| Code quality | Check for unrelated refactors, hardcoded paths, and security risks |
| Architecture boundary compliance | Check whether forbidden files or package boundary rules have been violated |
| precondition-fix annotation | If a change fixes a leftover issue from another phase in order to make the current phase's tests pass, label it `precondition-fix` rather than scope creep |

## Structural Quality Gate

The following are blocking by default (not merely suggestions — they are admission criteria):
- Adding a special-case branch inside a busy flow instead of extracting a helper/adapter (e.g., hardcoding a close-stage-specific check inside the general stageExit logic)
- Feature-specific logic leaking into a shared/general path
- Duplicating an existing canonical helper or re-implementing an existing capability
- Introducing absolute paths, hardcoded user paths, or environment-bound references
- Using `any` / `unknown` / `as` casts to mask real type boundaries
- Multi-step state updates that are non-atomic and may result in partial writes on failure
- Continuing to pile logic into a file that already exceeds 1000 lines without a justification for not splitting it
- Adding an abstraction/wrapper that does not reduce complexity (thin wrapper, pass-through helper)

## Verification Methods

1. **Run commands**: For dimensions such as tests passing and shell diagnostics, run the command directly and inspect the output.
2. **Read files**: For dimensions such as phase delivery completeness, diff scope, and code quality, Read the files and evaluate each item.
3. **Structured verification**: For dimensions such as RED/GREEN authenticity and precondition-fix annotations, output `jq` or other command results directly.

## Evidence Authenticity Dimension (FR-REV-002)

- Evidence files are located at `apply/evidence/phase-<N>-<MODE>.json` + `.stdout` + `.stderr`; gate has verified provenance (evidence_captured hash)
- When reviewing, Read the evidence JSON and confirm that command, exit_code, and timestamp are reasonable
- **No placeholders**: evidence stdout/stderr content must not contain truncation markers such as `...`, `(omitted)`, or `(same as above)`
- **Host-Verified Facts take priority**: When the review package includes a Host-Verified Facts section, the reviewer does not re-run the evidence command (the host has already verified provenance and exit_code). The reviewer still reads the evidence JSON to confirm command/exit_code/timestamp reasonableness and reads stdout/stderr to check for placeholders. If Host-Verified Facts contradict the reviewer's findings → escalate_to_human (fail-closed)

## FR Consumption Point Scan Review Dimension (Return-Revision Granularity Discipline Enforcement)

When a blocking finding from the previous round falls into the category of [missing required input / suppressed fallback / validation field gap / FR implementation consumption point drift], the reviewer must read `apply/phase-<N>-revise-plan.md` (or the corresponding `revise-plan-checklist`) from the current round and verify the `FR Consumption Scan` section:

1. **Does the search term matrix truly provide coverage?**: The search term set must cover at minimum the FR's ID + core field names + entry function names + template titles/anchors + test names; each term must include a grep command + matched output. Only grepping the FR ID alone is insufficient (consumption points frequently appear under aliases, field names, or schema keys — a single grep misses call sites and reproduces the drift).
2. **Are hit points classified?**: Each hit point must be labeled "consumption point / non-consumption point + reason"; missing classification or a vacuous reason → revise_required.
3. **Does the test mapping hold?**: Each consumption point must correspond to one regression test (in a table); uncovered consumption points must either have a corresponding new test or a valid and stated blocking/exemption reason (a single prose sentence is not sufficient).
4. **Exemptions cannot bypass via empty checkbox**: If the revise-plan has no FR Consumption Scan but claims "this round does not involve FR implementation", a valid exemption reason + the corresponding finding ID + a file:line reference the reviewer can verify must be provided. If the reviewer determines that the blocking issue does involve FR implementation but the Scan is missing or the exemption reason is invalid → revise_required.

Criteria: Scan section missing / partially filled / filled with filler text / exemption invalid → revise_required. If the reviewer flags a consumption point in one round and flags another hit of the same entry point and same class in the next round, this discipline has not been executed and the finding is treated as unclosed and escalated.

## Same Finding Consecutive 2-Round Escalation Rule (FR-REV-001)

When the same blocking finding remains unclosed across 2 consecutive review rounds, the reviewer must output:
1. **Root cause**: Why this problem keeps recurring
2. **Scan scope**: A list of all potentially affected files/modules
3. **Counter-example matrix**: Positive and negative examples for each affected location
4. **Closure checklist**: A per-item checklist the agent must confirm as fixed

If the same finding remains unclosed in round 3 → escalate_to_human.

## Substantive Review Dimensions

Among the formal checks, evidence existence and content quality are already automated by gate.sh phase_pre_review (FR-REV-003). Other formal checks (chat archiving, screenshots, file format) are not yet covered by gate; the reviewer checks these as needed. The reviewer's focus is on 4 substantive dimensions:
1. Should it be done at all — requirement reasonableness
2. Is it done correctly — solution correctness
3. Are there risks — hidden risks
4. Is anything missing — coverage completeness

## Revision Record

The review report body (everything above `<!-- revision-record -->`) must not be modified. After receiving revise_required and before initiating the next review round, the main agent appends a revision record at the bottom of the previous round's report in append-only fashion. The reviewer reads only, never writes.

Append format (**gate enforces the sourceRequestId/sourceRound/resubmitRound triplet — any missing field will BLOCK**):
```
<!-- revision-record -->

## Revision Record
### Round N → N+1 (YYYY-MM-DDThh:mm:ss)
- **Failure root cause**: <why this round did not pass>
- **Modified files**: <list of files>
- **Change summary**: <what was changed>
- **Verification commands and results**: <command + output>
- **sourceRequestId=<reviewRequestId from previous round>**
- **sourceRound=<N>**
- **resubmitRound=<N+1>**
```
