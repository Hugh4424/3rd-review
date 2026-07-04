# Test Acceptance Review Contract

> This file defines the inspection dimensions for the verify-code-reviewer. Findings outside this contract may only be marked `minor`, never `blocking`.

## Three-Axis Review

Every round must cover all three axes — none may be skipped:

| Axis | Meaning | Reference Source |
|----|------|--------|
| **Acceptance Coverage** | Whether all spec acceptance sections / plan-tasks test designs / user issues have been verified | spec.md (Chapter 10 + Chapter 3), plan.md, tasks.md, final-test-report.md |
| **Evidence Authenticity** | Whether evidence is fresh, raw, and reproducible | final-test-report.md, apply/evidence/, qa-only |
| **Workflow Closure** | Whether verifier, Knowledge, workflow-issues, and delivery boundaries are fully closed | verifier-report-index.md, reviews.jsonl, verify-change --light |

## Required Skill Execution

The reviewer must invoke directly:

- `qa-only`: Real user-perspective acceptance testing, report issues only, do not fix; must not substitute `qa` for `qa-only`.
- `verify-change --light`: Lightweight confirmation that all checkboxes are checked and verdict is closed; list remaining open findings in the current-stage index **but do not block on them** (prior stages already adjudicated — do not re-scan; `accepted`/`closed_inband` count as closed).

If a required skill is unavailable AND the SKILL.md file is unreadable, cannot be executed with a report-only lens, or its output lacks key conclusions → `escalate_to_human`. pass/revise output must include a top-level `skillResults` field recording executed / unavailable / failed for each skill. The `openspec-*` naming convention is prohibited in this repo.

**Skill Execution Fallback Rule**: The reviewer must first attempt to invoke required skills via the Skill tool. If the Skill tool fails in a headless/read-only environment, the reviewer must fall back — Read the SKILL.md file for that skill directly, extract the review dimensions and checklists from it, and apply them independently to the acceptance sources. When fallback succeeds, record `status=executed` and note `skill-file fallback` in the `mode` or `evidence` field. Must not substitute `qa` for `qa-only`; must not use `openspec-*` naming.

**Three-Element Evidence Summary Requirement (FR-REVIEW-006)**: The `evidence` field of each required skill must contain three elements: (1) **Where executed** — session location / record path; (2) **Specific inputs / checkpoints** — what was actually inspected; (3) **Conclusion** — what was found. Placeholder text such as "executed", "passed", or any entry without specific content is prohibited.

**Minimum Substance Threshold (FR-REVIEW-007)**: Criteria for identifying hollow summaries. Any of the following constitutes a hollow summary; the reviewer must downgrade to `failed`:
- evidence contains only status words with no inspection location
- evidence contains no specific checkpoints or input descriptions
- evidence lacks a conclusion
- Hollow example: `{"status":"executed","evidence":"ran verify-change, acceptance tests pass"}` — missing where it was executed, no specific inspection target
- Compliant example: `{"status":"executed","evidence":"(1) Skill tool in this session; (2) read final-test-report.md lines 1-45, checked FR-001/FR-002/FR-003 closure evidence; (3) FR-001/FR-002 closed with raw command output, FR-003 missing evidence — flagged blocking"}`
Automated machine validation against execution location paths is not required — judgment is by the reviewer's manual inspection; path accessibility is not required.

## General Principles

The review focuses on the quality of acceptance evidence, not the format of the report. Answer these 5 questions first:

1. **Is acceptance complete?** — Does every acceptance criterion have objective evidence?
2. **Is the evidence fresh?** — Was final-test-report produced by running tests in the current session?
3. **Is verifier closure complete?** — Are all latest verdicts pass? Remaining open/in_progress fix_status items **must be listed but must not be used as a basis for blocking** (current stage only; prior stages already adjudicated — do not re-scan; `accepted`/`closed_inband` count as closed).
4. **Is Knowledge complete?** — Are apply/phase, final-test-report, verifier reports, and progress all present?
5. **Are delivery boundaries clear?** — Have keep/exclude/split, artifacts, and governance changes all been classified?

## Incremental Review Rules

Round 1: Full review against all dimensions in this contract.

Round 2+:

1. Verify each prior-round blocking item one by one; unresolved → blocking.
2. Review only files changed in this round and affected sources.
3. If RuntimeAdapter / checkpoint / workflow boundaries, forbidden files, or cross-package interfaces are touched → full re-review of that module.
4. New blocking findings may only come from changes introduced in this round, issues that could not have been detected in prior rounds, or architecture/boundary touches; all other late findings are marked `minor`.
5. Each round is an independent session; review only the review package.

## Round-1 Mandatory Checks

All of the following must be executed in Round 1; discovering them in later rounds is not allowed:

1. `workflow-issues.jsonl` exists and has an entry appended for this task.
2. `fix_status` column in `verifier-report-index.md`: **list remaining open rows for the current stage (do not block on them)**. Inspect this column only; do not scan the summary.
   - Open set = `{ open, in_progress }`; closed (not considered open) = `{ closed, fixed, escalated, accepted, closed_inband }`.
   - Cross-stage scoping: count only rows where the stage column equals the current stage (`currentStage`); prior-stage open items already adjudicated are not re-scanned and not counted.
   - The reviewer must faithfully list the remaining open items for the current stage (checkpoint:round) in the report, noting "user acknowledged — allowed to proceed", but **must not use open items as grounds for revise_required**.
3. `spec acceptance section coverage check`: every AC in spec.md Chapter 10 (including Verification Method / AC ID) + every per-phase test design in plan/tasks must have evidence in final-test-report.
4. artifacts user issue closure: each original user issue from the intake must have acceptance evidence in final-test-report.

Finding a Round-1-detectable issue in Round 2+ → mark `late_finding: true`; usually only `minor`.

## Blocking / Non-Blocking Classification

**Blocking (revise_required must be issued)**:

- The reviewer did not genuinely invoke `qa-only` or `verify-change --light`.
- Final test report or verifier reports are missing.
- final-test-report references historical results such as "already ran before", "last-round verdict already passed", "logically should not have changed", or "same as Phase X".
- final-test-report does not preserve raw output in `<!-- round-N -->` segments, or overwrites previous rounds.
- Any item in the spec acceptance section (Chapter 10 AC) or plan/tasks test design is uncovered, or a spec acceptance criterion has no objective evidence.
- Not all original user issues from artifacts have been verified as resolved.
- Acceptance commands are not all green, typecheck has errors, or project-related test/build was not executed and there is no alternative check.
- skipped, only, todo, or temporarily disabled tests are present.
- Evidence is missing an evidence JSON file path, a genuine exit_code, or time/session/commit characteristics; or evidence contains `...` / `(omitted)` / `(same as above)`.
- Multi-step acceptance evidence is missing the raw output of any step, or a step uses "as shown above" as a substitute.
- ~~verifier-report-index has open/in_progress findings~~ **(downgraded, moved to non-blocking)**: remaining open/in_progress findings no longer block; the reviewer lists the current-stage open items as-is (user has decided open items are downgraded to acknowledged), `accepted`/`closed_inband` count as closed, prior-stage open items are not re-scanned.
- The latest review of design/plan/code has not passed, or there is no fix record for a revise_required.
- UI/browser/user flow is in scope but `isolated-browser-qa` was not used, or screenshots/traces are missing.
- Browser QA screenshot hashes are duplicated, or the browser QA tool name recorded in final-test-report contradicts that in close/summary.
- A frontend change is missing a "visual comparison acceptance" section.
- When using design-fidelity-component-contract: the design contract does not exist or is not the latest, or the component implementation cannot be aligned to the contract.
- Delivery is out-of-scope, spec goals are omitted, differences are unexplained, or the current change cannot be told as a complete, independent user story.
- Constraint synchronization is incomplete, or the full-change self-consistency has not been verified.

**Acceptance Indicator Soft Gates (FR-ORACLE-001/002/003)**:

- **FR-ORACLE-001 Denominator Check**: For each acceptance metric in the spec acceptance section (Chapter 10), is the denominator stated (i.e., "what is the Y in X/Y")? If any metric lacks a denominator (e.g., writing only "coverage 80%" without stating "at least M of N total ACs") → revise_required.
- **FR-ORACLE-002 Paired Reverse Assertions**: For each behavioral assertion, is both the positive side (X must happen) and the negative side (Y must not happen) declared? If any assertion has only the positive side and is missing the negative side → revise_required.
- **FR-ORACLE-003 Acceptance Source Verification**: Does every AC in the spec acceptance section / plan-tasks test design have a stated source? For sources filled in by the implementer (e.g., "manually measured", "created in this iteration"), is there independent confirmation (not self-attested by the same person)? If the source is missing or not independently confirmed → revise_required.

**Non-Blocking (pass may be issued; may mark important/minor)**:

- Browser QA screenshot paths could be clearer.
- Test report wording could be more precise.
- Non-binding configuration reminders.
- E2E fixtures not contract-derived but not affecting current delivery → mark important; if they affect acceptance credibility → escalate to blocking.

## Inspection Dimensions

| Dimension | Verification Method |
|------|---------|
| Required Skills executed | Check qa-only and verify-change --light output; if required skill cannot be executed → escalate |
| Acceptance matrix | Compare spec Success Criteria against final-test-report evidence item by item |
| spec acceptance section check | Every AC in spec Chapter 10 + every per-phase test design in plan/tasks has command/screenshot/report evidence in final-test-report |
| User issue closure | Every original issue in intake artifacts has acceptance evidence |
| Fresh verification | final-test-report produced by running tests in current session; historical references prohibited |
| round raw output | Check `<!-- round-N -->` segments; must not overwrite previous rounds |
| Commands all green | Execute or verify `pnpm test`, `make test`, project-specified commands |
| typecheck passes | Execute or verify `pnpm typecheck` or project-specified typecheck |
| Test credibility | Check for skipped/only/todo, temporarily disabled tests, docs-only substitute checks |
| Evidence authenticity | evidence JSON file exists, provenance hash matches, exit_code/timestamp are reasonable |
| verifier closure | reviews.jsonl and index structure consistent; remaining open/in_progress fix_status items in `fix_status` column **listed but not blocking** (current stage only; prior stages not re-scanned); `accepted`/`closed_inband` count as closed |
| workflow-issues | File exists and has this task's stage entry appended |
| Knowledge close | task.md, AGENTS.md, progress.md, apply/phase, test/final-test-report, verifier reports all present |
| Browser QA | For UI scope: isolated-browser-qa, screenshots/traces, screenshot hashes unique, tool source consistent |
| Visual comparison | Frontend changes must have a "visual comparison acceptance" section |
| Design contract acceptance | design-contract/ui-contract is latest; component implementation is consistent with the contract |
| Scope and risk | out-of-scope, missed goals, unexplained differences, whether to defer archive |
| Three-round escalation | 3 consecutive rounds of revise_required require a documented root-cause analysis filed in the project's designated knowledge/retrospective location |
| FR line-by-line verification (FR-ACCEPT-002) | Compare every functional requirement in plan/spec one by one; **sampling is prohibited**: issuing pass after spot-checking a few FRs is insufficient review; any FR not verified → blocking |
| Original requirements fully resolved (FR-ACCEPT-003) | Compare against the intake original-requirements ledger/decision-log and verify **one by one** that each original requirement has been **completely resolved** (not merely "has an FR mapping" but confirmed that the implementation satisfies the requirement); any item not completely resolved or not verified → blocking |
| dogfood exemption justification (FR-DOG-002) | If a deliverable is deemed a pure library / pure documentation / pure configuration and therefore exempt from dogfood live-running, the reviewer's output must explicitly state the exemption reason (why it qualifies as pure library/documentation/configuration and contains no behavior-shaping logic); missing exemption reason → revise_required |

## Fresh Verification: Genuine vs. Fake

- final-test-report must be raw output from the current session.
- Any historical-reference wording found → immediately `revise_required`.
- Each `<!-- round-N -->` segment should contain a unique characteristic of the current session: session_id, actual timestamp, or current commit hash.
- 3 consecutive rounds with evidence issues on the same verification item → mark the finding `repeat: true` and `escalate_to_human`.

## Browser Acceptance Rules

For UI/browser/user-flow changes, the following are mandatory:

- Must use `isolated-browser-qa`; manual verbal acceptance alone is not sufficient.
- Must have screenshots or traces.
- Execute screenshot hash uniqueness check: duplicate hashes → blocking.
- The browser QA tool name in final-test-report must be consistent with that in close/summary.
- If verification is not possible, pass must not be issued; missing/blocking must be written.

## Knowledge Close and Delivery Boundaries

- Check `task.md`, `AGENTS.md`, `progress.md`, `apply/phase-*.md`, `test/final-test-report.md`, `reports/*.md`.
- pass does not mean delivery is complete; `close/summary.md` must be written and the user must explicitly say "proceed with delivery" or an equivalent expression before archive/merge/branch deletion/seven-item verification.

## Verification Methods

1. **Skill cross-check**: Verify one by one whether qa-only/verify-change --light findings are reflected in the verdict; if required skill was not genuinely invoked → escalate.
2. **Execute commands**: Run or verify raw output for test/typecheck/build/fresh check.
3. **Read files + grep**: Inspect verifier-report-index, reviews.jsonl, workflow-issues, final-test-report, baseline.
4. **Column-level inspection**: In verifier-report-index, inspect only the `fix_status` column; list remaining open/in_progress items for the current stage (list but do not block; prior stages not re-scanned; `accepted`/`closed_inband` count as closed).
5. **Directory inspection**: Screenshots, traces, Knowledge artifacts must exist and be non-empty.
6. **Cross-reference**: Map spec ACs, baseline, user issues, and final evidence item by item.

## Evidence Authenticity Dimension (FR-REV-002)

- Evidence files are located at `apply/evidence/phase-{N}-{MODE}.json` + `.stdout` + `.stderr`; gate has verified provenance.
- During review, Read the evidence JSON to confirm that command, exit_code, and timestamp are reasonable.
- `...` / `(omitted)` / `(same as above)` are prohibited.
- **Host-Verified Facts take priority**: When the review package contains a Host-Verified Facts section, the reviewer does not re-run evidence commands. The reviewer still reads the evidence JSON to confirm command/exit_code/timestamp reasonableness, and reads stdout/stderr to check for placeholders.
- If Host-Verified Facts contradict reviewer findings → `escalate_to_human` (fail-closed).

## Same-Finding Two-Round Escalation Rule (FR-REV-001)

When the same blocking finding remains unclosed for 2 consecutive rounds, the finding must include:

1. Root cause.
2. Scan scope.
3. Counterexample matrix.
4. Closure checklist.

If still unclosed in Round 3 → `escalate_to_human`.

## Revision Record

After receiving `revise_required` and before initiating the next review round, the main agent must append-only record: failure root cause, modified files, modification summary, verification commands, and results. The reviewer reads only, does not write; a missing revision record is treated as missing evidence.
