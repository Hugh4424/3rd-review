# Intake Review Unified Reviewer Contract

> This file defines the shared rules and dimension-specific rules for both intake reviews (direction / detail).
> Findings outside the contract scope may only be marked `minor`; marking them `blocking` is not permitted.

---

## General Provisions (shared by both reviews)

### Scope

This contract applies to the intake-direction-review and intake-detail-review prompts. Each prompt references the corresponding section of this contract as its source of review dimensions and blocking rules. The four scope dimensions (Real Pain / Complexity ROI / Risk Scope / Timing) are inlined in this scope section; no separate scope contract exists.

### Finding Classification Rules (MR-2)

All findings must be categorized into one of the following four classes before deciding whether a `blocking` label is permitted:

| Class | Meaning | May be marked blocking? |
|-------|---------|:---:|
| **Problem Change** | Direction-level — the problem being solved has changed (genuine pain vs. agent-invented problem) | ✅ Yes |
| **Scope / Priority** | Direction-level — whether this should be done now, or whether the scope boundary is reasonable | ✅ Yes |
| **Requirement Interpretation** | Direction-level — disagreement on how to read the original requirement | ✅ Yes |
| **Implementation-Only** | Dispute over approach / implementation details that does not affect the direction decision | ❌ Must be downgraded to non-blocking |

**Implementation-Only handling rules**:
- When a finding is implementation-only, any `blocking` label must be downgraded to `important` or `minor`; blocking may not be used to stall progress.
- If the reviewer believes the implementation risk is severe enough (e.g., the approach is infeasible and the requirement cannot be delivered), use `escalate_to_human` to hand off to Stage 1 (Design) — do not use `blocking` to hard-stop at the intake stage.

### Incremental Review Rules

Round 1: Full review — produce findings against all dimensions in the applicable section.

Round 2+:
1. Verify each blocking finding from the previous round one by one; if unresolved → blocking.
2. If upstream decisions or requirements have changed, perform a full re-review of those changes.
3. New blocking findings may only arise from new information in this round or issues that could not have been found in the previous round; all other late findings must be marked `minor`.

### Same-Finding Consecutive 2-Round Escalation Rule (FR-REV-001)

When the same blocking finding remains unclosed for 2 consecutive rounds, the finding must include: root cause, scan scope, counterexample matrix, and a Closure checklist.
If still unclosed after round 3 → `escalate_to_human`.

### Revision Record Rules

After receiving `revise_required` and before initiating the next review round, the main agent must append-only record: failure root cause, modified files, change summary, verification commands and results. The reviewer is read-only; a missing revision record is treated as missing evidence.

### Knowledge Path Rules

- Correct project root: `{{task_tracking_root}}`.
- Task files are located at `{{task_tracking_root}}/tasks/{task-id}/`.
- If any artifact contains a user-specific absolute path (e.g. `/Users/{username}/...`) or a legacy project-specific literal path that does not belong in the current review context → `escalate_to_human`.

---

## Direction Section (applies to intake-direction-review)

### Three-Axis Review

Every round must cover all three axes without exception:

| Axis | Meaning | Reference Source |
|------|---------|-----------------|
| **Direction Fit** | Does the requirement direction align with the project's positioning, constraints, and the user's real goals | intake-original-context.md, contract.md, plan-ceo-review |
| **Demand Reality** | Authenticity of the problem — is this a genuine user pain point or an agent-invented problem | intake-original-context.md, review skill output |
| **Premise Safety** | Are the direction-level assumptions sound — are there fragile premises that would cause everything to collapse if wrong | intake-original-context.md, plan-ceo-review |

### Required Skill Execution (Direction Section)

The reviewer must directly invoke:

- `plan-ceo-review`: premise challenge, scope mode, existing leverage, implementation alternatives, dream state delta, risk review.
- `review`: independently re-review the requirement direction, user pain points, and solution premise assumptions.

If the required skill does not exist, cannot run, cannot execute in report-only mode, or its output is missing key conclusions → `escalate_to_human`.

### General Principle (Direction Section)

The core judgment of direction review: **Is this requirement direction correct? Is the problem real? Is it worth doing?**

Answer these 5 questions first:
1. **Direction Alignment** — Does this requirement direction target the user's genuine need, or is it a derivative of the agent's interpretation?
2. **Problem Reality** — When the user says something "hurts," is it actually painful or merely "sounds like it should hurt"? Are there counterexamples?
3. **Entry Point Reasonableness** — Is the currently planned minimum footprint truly minimal? Is there a simpler alternative path?
4. **Fragile Premise** — Which assumption in the direction, if wrong, would make the entire effort worthless?
5. **Timing** — Do this now or wait for some prerequisite dependency to be ready?

### Blocking / Non-Blocking Classification (Direction Section)

**Blocking (must produce revise_required)**:
- The requirement direction clearly deviates from the user's original intent (explicit contradiction found in intake-original-context.md).
- The requirement solves an agent-invented problem, not a genuine user pain point.
- A direction-level assumption is falsified ("fragile premise" that collapses the whole effort if wrong).
- A clearly superior alternative path exists, and the current path's obvious risks are deliberately ignored.
- A user-approved scope decision is overturned at the direction level: downgrade to a risk reminder; blocking is not permitted.

**Non-blocking (should produce pass, may mark important/minor)**:
- No fundamental error in direction, but the entry point could be smaller.
- Direction is correct but premises are not stated explicitly enough.
- Risk reminders for scope decisions already approved by the user.
- Suggestions for scenario prioritization.

### Review Dimensions (Direction Section)

| Dimension | Verification Method |
|-----------|-------------------|
| Required Skills executed | Check plan-ceo-review / review output. Cannot execute → escalate |
| Direction aligned with user goals | Compare only against intake-original-context.md; does direction target the user's original intent (reading decision-log.md is prohibited) |
| Problem authenticity | Check whether pain points have original evidence (user verbatim, data, known bugs), or are agent-constructed |
| Alternative path evaluation | Were other directions considered? Is there a record of "why not do it this way instead" |
| Fragile premises | Among assumptions implicit in the original requirement, are any "the whole effort is wasted if this is wrong" |
| Requirement / solution separation | Is the direction layer locked on the "problem" rather than the "solution" |
| Scope boundary | Does the direction clearly state what is in scope and what is explicitly out of scope |
| Timing judgment | Do this now or wait for some prerequisite condition to be ready |

### Conciseness Non-Blocking Check (Direction Section, see FR-GOV-001)

The reviewer performs a **non-blocking** check of the conciseness of replies to users (may not be marked `blocking`; only `important` or `minor` is permitted):
- **Conclusion first, details second**: Does the main agent's reply lead with the conclusion before expanding on details?
- **Plain language**: Is there jargon pileup or exposure of internal paths?
- **Appropriate table use**: Are tables used only for side-by-side comparisons?
- **Artifact structure**: Summary first, details after?

### Framework Challenge Function (applies to intake-direction-review; fully blind review)

The framework challenge does not evaluate whether the direction is correct; instead it questions "should the problem be framed this way" — **without knowing the proposed direction**, it checks whether there are framework-level alternatives that have not been considered. This is one of the core functions of intake-direction-review, built into the direction section review.

| Dimension | Verification Method |
|-----------|-------------------|
| Problem frame correctness | Is the "problem space" in which this requirement is defined sound? Could it actually be an entirely different problem? |
| Framework-level alternatives | Is there a completely different solution framework from the current proposed direction that has not been considered? |
| Implicit constraint challenge | Do the constraints the current direction depends on actually hold? What happens if the constraint is removed? |
| Framework-level risk | If the wrong direction is chosen, what is the blast radius and the rollback cost? |

If a framework challenge is valid → may be marked blocking (handled within the direction section; does not go through implementation-only downgrade).
**The input for the framework challenge contains only the original requirement; including any proposed direction is prohibited. If a proposed direction is found in the review package → immediately `escalate_to_human`.**

---

## Detail Section (applies to intake-detail-review)

> **Note**: intake-detail-review is a comprehensive review that covers four dimensions in a single pass: Blindspot, Detail, Drift, and Scope. This section defines the rules for each dimension; the complete review checklist is in `make-decision-detail-reviewer.md`.

### Five-Axis Review

Every round must cover all five axes without exception:

| Axis | Meaning | Reference Source |
|------|---------|-----------------|
| **Source Accuracy** | Is the source type of each decision (verbatim requirement / derived / newly added) truthfully recorded | decision-log section 3, intake original context |
| **Decision Consistency** | Are there logical contradictions among D1–D13 (or existing decisions) | decision-log full document |
| **Assumption Completeness** | Are there critical fragile assumptions missing from the assumption section | decision-log section 4, actual dependencies |
| **Verifiability** | Are acceptance criteria verifiable and unambiguous | decision-log section 7 |
| **Open Issue** | Which open issues should actually be resolved now | decision-log section 6 |

### Required Skill Execution (Detail Section)

The reviewer must directly invoke:

- `review`: independent re-review — focus on detail quality; do not repeat direction / blindspot content.

If the required skill does not exist, cannot run, cannot execute in report-only mode, or its output is missing key conclusions → `escalate_to_human`.

### General Principle (Detail Section)

The core judgment of detail review: **Does the decision record itself hold up to scrutiny?**

Answer these 5 questions first:
1. **Honest labeling** — Is the "source type" of each decision honest or beautified? Is "derived" or "newly added" being disguised as "verbatim requirement"?
2. **Internal consistency** — Do the decisions contradict each other? Are the downstream decisions from D1 consistent with D1's intent?
3. **Assumption completeness** — Does section 4's assumptions cover all fragile premises? Are there any obvious ones missing?
4. **Verifiability** — Can each acceptance criterion in section 7 be objectively evaluated? Is there vague language?
5. **Issues that cannot wait** — Which open issues in section 6 should actually be resolved now rather than deferred to implementation?

### Blocking / Non-Blocking Classification (Detail Section)

**Blocking (must produce revise_required)**:
- Source type falsification: disguising "newly added" or "derived" as "verbatim requirement."
- Logical contradiction between decisions, and allowing them to proceed would make the plan unimplementable.
- A critical fragile assumption is not recorded, and its collapse would invalidate the current plan.
- Acceptance criteria are ambiguous / indeterminate and cannot support gate progression.
- A clearly implementation-ready open issue is deferred without explanation.
- Version anchors for decisions are missing or stale.

**Non-blocking (should produce pass, may mark important/minor)**:
- Secondary assumptions are not explicit enough but are not fragile.
- Acceptance criterion wording could be more precise but does not affect judgment.
- Suggestions for prioritizing open issues.
- Decision record format suggestions (numbering conventions, wording, etc.).

### Review Dimensions (Detail Section)

| Dimension | Verification Method |
|-----------|-------------------|
| Required Skills executed | Check review skill output. Cannot execute → escalate |
| Source type honesty | Compare each decision against its verbatim source: does it truly come from user verbatim, or is it agent-derived |
| Decision consistency | Check the logical chain across decisions: is Dn compatible with Dn+1 |
| Assumption completeness | Does the assumption section include critical premises whose failure would collapse the plan |
| Acceptance testability | Can each acceptance criterion be verified by running a command / log check / manual judgment |
| Open issue timeliness | Check which open issues should be resolved in this stage rather than deferred to implementation |
| Version anchor | Does the decision-log frontmatter version exist and is it current |

### Blocking / Non-Blocking Classification (Blindspot Dimension)

**Blocking (must produce revise_required)**:
- A critical stakeholder or user group is omitted, causing the design to have incomplete coverage.
- An uncovered failure mode would cause real damage under the current design.
- A default premise the direction decision depends on is falsified or explicitly unreliable.
- False consensus exists (multiple parties agree because they are confirming each other rather than judging independently).

**Non-blocking (should produce pass, may mark important/minor)**:
- Scenario coverage is not granular enough but does not affect the direction decision.
- Suggested boundary test cases to add.
- Long-tail maintenance costs have not been estimated but do not affect the MVP.
- Assumptions that are not explicit enough but are not fragile.

### Blocking / Non-Blocking Classification (Drift Dimension)

**Blocking (must produce revise_required)**:
- Direction-level drift: the proposed direction solves a problem that the user did not actually raise.
- A core concern from the original requirement is ignored or downgraded in the decision-log.
- Scope was expanded without user confirmation (not in the original text and not acknowledged in intake-original-context.md's original requirement register).

**Non-blocking (should produce pass, may mark important/minor)**:
- Direction is broadly aligned with the original requirement but wording has a minor interpretive drift.
- Priority of a secondary requirement is slightly adjusted with sufficient justification.

### Blocking / Non-Blocking Classification (Scope Dimension)

**Blocking (must produce revise_required)**:
- A pain point dimension is labeled "evidence" yet has no user verbatim / data source (false evidence — disguising subjective as objective).
- The verdict is "can do" but the risk-and-impact-scope dimension is clearly negative or "indeterminate," making the verdict self-contradictory with the four-dimension conclusions.
- The discard register has an entry but is missing a discard reason or disposition (per FR-TWZ-008; missing reason has mandatory blocking force on the verdict).
- The pain point is an agent-invented problem with no support in the original context (MR-2 "Problem Change" class).

**Non-blocking (should produce pass, may mark important/minor)**:
- The four-dimension conclusions are correct but evidence for a given dimension could be more solid.
- The verdict is reasonable but the override-condition checklist is not specific enough.
- ROI estimate is optimistic but direction is sound.
- Implementation-only complexity disputes (must be downgraded to non-blocking per MR-2).
- A user-approved scope decision is overturned: downgrade to a risk reminder; blocking is not permitted.

### Scope Four Dimensions (inline definition)

| Dimension | Meaning | Reference Source |
|-----------|---------|-----------------|
| **Real Pain** | Is this a genuine user pain point or an agent-invented / inferred problem | intake-original-context.md, decision-log.md |
| **Complexity ROI** | Is the change volume estimable, and does the ROI hold (quantifiable vs. guesswork) | decision-log.md, plan-ceo-review |
| **Risk Scope** | Is the change boundary clear, and can the affected modules be enumerated | decision-log.md, plan-ceo-review |
| **Timing** | Is now the right time; are there prerequisite dependencies or resource conflicts | decision-log.md, project plan / phase goals |

Five core judgment questions for the scope dimension:
1. Is the pain point supported by user verbatim / data, or is it agent inference?
2. Is complexity estimable? Is ROI quantifiable or guesswork?
3. Can the change boundary be enumerated? Is "cannot determine impact scope" being treated as "risk is manageable"?
4. Do this now or defer? Are there prerequisite dependencies / resource conflicts being ignored?
5. Is the four-option verdict (can do / can do but defer / risky, needs scope limit / not recommended) consistent with the four-dimension conclusions? Is an override-condition checklist present?

---

## Revision Record

After receiving `revise_required` and before initiating the next review round, the main agent must append-only record: failure root cause, modified files, change summary, verification commands and results. The reviewer is read-only; a missing revision record is treated as missing evidence.
