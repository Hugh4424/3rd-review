# Step 6: verdict Dispatch + post-pass Actions + Round Escalation Rules

> This file is referenced by the 3rd-review SKILL.md thin shell; the main session does not read it. Reviewers/scripts read on demand.

### Step 6: verdict Dispatch

> review-persist.sh (step 5) has already executed atomically: review_dispatched journal → reviewer_output gate → index rebuild. No manual repetition needed.

#### 6a. verdict = pass → post-pass retention actions

The main agent must execute the following steps in order (none may be skipped):

> **post-pass retention is completed automatically by the host (FR-EVID-001/002)**: on a pass verdict, the host automatically writes `workflow_feedback_captured` + `stage_summary_end` journal events at the reviewer_output gate. **The agent no longer needs to manually run `/skill capture-workflow-feedback` or `/skill stage-summary end`, and must not manually append-journal-once for these two event types** (manually writing host events causes conflicts instead).
> - The `workflow-issues.jsonl` ledger is still validated via the gate path: zero findings in normal operation is legitimate (`issues_count: 0`); when genuine findings exist, append ledger entries normally. The host's automatic feedback journal does not replace the ledger content itself. Only spawn a sub-agent to call `capture-workflow-feedback` when deep workflow-issue analysis is genuinely needed.

**Step 6a-2: post_review_pass gate**
```bash
bash packages/core/agenthub/harness/gate.sh post_review_pass {workflow-id} \
  --checkpoint-id="{checkpoint-id}" --round={N} --task-dir={TASK_DIR}
```
(agenthub platform path; not in the standalone repo)

→ gate checks that both `workflow_feedback_captured` and `stage_summary_end` journal entries written automatically by the host are present. If either is missing → exit 2

**Step 6a-3: stage_advance**
```bash
bash packages/core/agenthub/harness/gate.sh stage_advance {workflow-id} \
  --task-dir={TASK_DIR} [--last-phase=true]
```
(agenthub platform path; not in the standalone repo)

→ advances to the next phase/stage. gate requires currentStatus=ready_to_advance (written after post_review_pass succeeds)

#### 6b. verdict = revise_required → fix loop

The main agent must execute in order:

1. `/superpowers-receiving-code-review` — digest the review report first; jumping directly to code fixes is not allowed
2. Generate `apply/phase-N-review-intake.md`, which must include: Findings, Root Cause, Fix Plan, Scope Check, Evidence Plan, Re-review Plan
3. Append a `status=planned` record to `review-fixes.jsonl`, binding checkpoint, sourceRequestId, sourceRound, sourceReport
4. `gate.sh review_intake_complete` — only after passing may the agent enter `revising`
5. Generate `apply/phase-N-revise-plan.md`
6. `/superpowers-test-driven-development` — RED/GREEN re-collection
7. Append a `<!-- revision-record -->` section to the end of the previous round's reports/*.md
8. Update `review-fixes.jsonl` to the complete fix record
9. `gate.sh phase_pre_review` — confirm fix quality
10. Return to step 2 (checkpoint_request next round)

For non-first-round checkpoint_requests, all of the above steps are checked (skill calls + phase_pre_review + evidence re-collection + revise-plan + revision-record + review-fixes AJV validation + hash verification) — 8 gate checks in total.

#### Dynamic Escalation Rules (FR-REVIEW-011)

Review rounds have **no fixed upper limit**. The reviewer skill layer dynamically determines the path using the following rules:

1. **Root cause first every round**: fixing code without an explicit root-cause analysis is not allowed. Before each round of fixes, `apply/phase-N-review-intake.md` containing a Root Cause section must be generated.

2. **Same issue for 4 consecutive rounds → escalate_to_human**:
   - Determination criterion: the same finding (same file, same category, same core description) appears in 4 consecutive review reports and remains blocking
   - Output: `escalate_to_human`, with an explanation that "the same finding has been unresolved for N consecutive rounds; human intervention required"
   - **This determination is made at the reviewer skill layer**, not dependent on a workflow-engine-level counter; no fixed round counter is hardcoded in production code

3. **Switching review form is not the same as relaxing guardrails**:
   - In later rounds, if issues are process/evidence problems (not code logic problems), switching to a clean sub-agent degraded form to advance is acceptable
   - The switch **is still subject to hard-rail constraints** (FR-REVIEW-004/005 unchanged): high-risk dimensions are still reviewed in full, regression coverage does not decrease
   - Switching form ≠ lowering the standard; the definition and threshold for a blocking finding remain consistent across all forms

4. **Root cause before fix**: fully understand the previous round's blocking findings before executing fixes. Patching over problems with surface fixes before the root cause is understood is prohibited.

**Cross-reference**: when switching to the sub-agent degraded form, all hard-rail layers (FR-REVIEW-004) are retained; see the "hard rail layer" definition above for guardrail constraints.

#### Degradation Routing Rules (FR-DEG-001/002/003)

`applyPostRoundDegradation` is applied automatically on the CLI `--history` path. Rules are as follows (thresholds and new-domain criteria all come from the `degradation` section of `route-rules.json`; nothing is hardcoded):

| Previous-round state | Current-round finding situation | Result |
|---|---|---|
| Any | finding count ≤ `maxFindingsForDowngrade` (including a single blocking finding) | Downgrade → R6 (same-source sub-agent) |
| Any | finding count > threshold and all non-blocking | Downgrade → R6 |
| Already downgraded (R6) | Has blocking and belongs to a **new domain** (FR-DEG-002) | Upgrade back to R1 (cross_source_with_subagent) |
| Already downgraded (R6) | Has blocking but **not a new domain** (FR-DEG-001 sticky) | Stay at R6 (no automatic upgrade back to R1) |
| Not downgraded | finding count > threshold and contains blocking | Maintain R1 |

**New-domain determination (FR-DEG-003)**: a finding is classified as a new domain if any of the following conditions is met:
- `finding.domain` is in the `newDomainRules.domainLabels` list, and the immediately previous round did not cover that domain
- `finding.lensType` is in the `newDomainRules.lensTypes` list, and the previous round did not cover that lensType
- `finding.codePath` matches a prefix in `newDomainRules.pathPrefixes`, and that path was not seen in the previous round

A downgraded R6 decision must carry `cleanContextRequired: true` (FR-QUALITY-001).

#### 6c. verdict = escalate_to_human → stop

The main agent outputs the escalation reason and waits for human intervention.
