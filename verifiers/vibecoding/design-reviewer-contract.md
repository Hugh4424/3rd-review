# Design Review Contract

> This file defines the inspection dimensions for the design-reviewer. Findings outside this contract may only be marked `minor`, never `blocking`.

## Three-Axis Review

Every review round must cover all three axes — none may be omitted:

| Axis | Meaning | Reference Source |
|----|------|--------|
| **Problem Fit** | Does the spec solve a real, approved problem? | SPEC.md, constitution, intake artifacts, plan-ceo-review |
| **Spec Quality** | Are FRs, scenarios, acceptance criteria, and non-goals sufficient to enter planning? | spec.md, review skill output |
| **Boundary Safety** | Does the spec overstep boundaries, leak implementation details, or violate AgentHub/Knowledge/UI boundaries? | contract.md, CLAUDE.md, plan-design-review |

## Required Skill Execution

The reviewer must directly invoke:

- `plan-ceo-review`: premise challenge, scope mode, existing leverage, implementation alternatives, dream state delta, risk review.
- `review`: independently re-examine design goals, user paths, acceptance boundaries, diff/scope drift.
- `plan-design-review`: required when UI is in scope; covers information architecture, interaction states, user journeys, AI slop risk, design system, responsiveness, accessibility, and open design questions.

If a required skill is unavailable and its SKILL.md file is unreadable → `escalate_to_human`. pass/revise output must include a top-level `skillResults` object recording each skill as executed / not_applicable / unavailable / failed.

**Skill Execution Fallback Rule**: The reviewer must first attempt to invoke required skills via the Skill tool. If the Skill tool fails in a headless/read-only environment, the reviewer must fall back — directly Read that skill's SKILL.md file, extract the review dimensions and checklists, and apply them independently to the design sources. When fallback succeeds, record `status=executed` and note `skill-file fallback` in the `mode` or `evidence` field. This fallback rule applies to all required skills universally; no per-skill configuration is needed.

**Three-Element Evidence Requirement (FR-REVIEW-006)**: The `evidence` field for each required skill must contain three elements: (1) **Where executed** — session location or record path (e.g., `skill tool in this session` or `SKILL.md fallback: path/to/SKILL.md`); (2) **Specific inputs/checkpoints** — what was actually checked (e.g., specific file paths, review dimensions); (3) **Conclusion** — what was found (e.g., "design goals align with SPEC, no drift" or "FR-002 missing acceptance criteria coverage"). Placeholders such as "executed", "passed", or any content-free filler are prohibited.

**Minimum Substantive Content Threshold (FR-REVIEW-007)**: Criteria for identifying hollow summaries. Any of the following conditions renders evidence hollow; the reviewer must downgrade to `failed`:
- evidence contains only status words with no execution location (e.g., `"executed: skill ran ok"`)
- evidence lacks specific checkpoints or input descriptions (e.g., `"checked the design"`)
- evidence is missing a conclusion (e.g., `"result: ok"`)
- Hollow example: `{"status":"executed","evidence":"ran plan-ceo-review, no issues"}` — missing execution location and specific review dimensions
- Compliant example: `{"status":"executed","evidence":"(1) skill tool in this session; (2) checked FR-001/FR-002 mapping against spec.md lines 12-34; (3) FR-001 covered, FR-002 missing acceptance criteria"}`
Machine validation of execution location paths is not required — judgment is by the reviewer manually; path accessibility is not enforced.

## General Principles

The review focus is on substance, not format. Answer these 6 questions first:

1. **Goal Health** — Is the spec solving the problem stated in SPEC/requested by the user, or a problem the agent invented?
2. **Boundary Health** — Are module responsibilities clear enough to decide "where does a piece of code belong"?
3. **Decision Transparency** — Do important choices explain why this option was chosen over alternatives?
4. **Verifiability** — Do Success Criteria produce unambiguous pass/fail outcomes?
5. **SPEC Deviation Handling** — Are deviations from SPEC classified as spec downgrade, compatible evolution, or requiring human decision?
6. **Original Requirement Coverage** — Does every user question/decision in the intake have a FR or an explicit "won't do" statement?

## SPEC Deviation Decision Tree

When spec.md is found inconsistent with SPEC:

- SPEC does not explicitly specify → may be treated as an implementation detail difference; not blocking.
- SPEC explicitly specifies, and spec downgrades or deviates from intent → `revise_required` or `escalate_to_human`.
- SPEC explicitly specifies, and spec is a better, backward-compatible evolution → may pass, but mark the finding with `spec_evolution: true` and require SPEC to be updated at close.

## Incremental Review Rules

Round 1: Full review against all dimensions in this contract.

Round 2+:

1. Verify each prior-round blocking finding one by one; unresolved → still blocking.
2. Review only files changed in this round and affected sources.
3. If RuntimeAdapter / checkpoint / workflow boundaries, forbidden files, or cross-package interfaces are touched → perform a full re-review of that module.
4. New blocking findings may only come from changes in this round, issues that could not have been found in prior rounds, or architectural/boundary touches; all other late findings are marked `minor`.
5. Each round uses an independent session; review only the review package.

## Blocking vs. Non-Blocking Classification

**Blocking (must result in revise_required)**:

- Incomplete original requirement coverage: a user question/decision in decision-log.md has no FR and no explicit "won't do" statement.
- spec introduces a core concept (mode/branch/new state machine/new entity) not present in decision-log, without annotating its source and rationale in the spec.
- Design violates Coding Discipline Iron Rule 1 (introducing out-of-scope concepts): a new type/function/pattern/state machine/dependency cannot be traced back to a decision in decision-log.md or spec.md.
- **Claimed source truthfulness verification (FR-SRC-TRACE-001, hard directive, bidirectional cross-check)**: For every FR/scenario in the reviewed spec that claims a decision source (e.g., "derived from D8"), the reviewer must trace that claim to a real, existing entry in the decision-log. A claimed source not found in the decision-log = out-of-scope concept = `blocking` (violates Coding Discipline Iron Rule 1). **Reverse direction**: every decision in decision-log that modifies existing functionality must be listed in the spec's "Business Impact Scope" section; any omission is `blocking`. This verification is mandatory in every round regardless of whether the review prompt highlights it — "rough-grained FR correspondence" is not a substitute for per-entry source tracing.
- Scope drift: spec adds unapproved goals or removes user-approved goals.
- Reviewer overturning user-approved scope: must be downgraded to a risk finding; must not block.
- Success Criteria cannot be judged true or false by commands, operations, screenshots, logs, or manual steps.
- spec bundles multiple independent outcomes into one change, or disguises a purely technical slice as a user story.
- SPEC deviation downgrades the spec or alters the MVP in a way that requires user/human decision.
- AgentHub boundary errors: writing `vibecoding` as the platform's main flow, writing Runtime private capabilities into the platform contract, conflating RuntimeAdapter/workflow/checkpoint/Knowledge, Capability not evaluated per workflow/stage, deepseek not treated as a server-side verifier runtime, introducing deferred items such as template marketplace/PPT/research/full Gemini integration.
- File placement errors: product prompt/workflow ts/schema/types not in repo, Spec not under `specs/{feature}/`, Knowledge used as a template source of truth, task path not `{{task_tracking_root}}/tasks/{task-id}/`.
- Spec-Purity blacklist hit: absolute paths, hook event strings, TypeScript type field definitions, shell command lines.
- UI scope with no design materials, existing pages, screenshots, Figma, or design authorization, yet proceeding directly to implementation.
- UI spec does not list key states/interactions/elements that must not be added, or demotes interactive controls to read-only display.
- Acceptance verifies code only, not behavior: acceptance criteria check only code structure/existence/compilation without covering runtime behavior verification — reviewer must mark blocking. Pure documentation/configuration phases are exempt.
- checkpoint package missing stage, artifact, or acceptance criteria, or flow progression depends on file watching rather than explicit checkpoints.
- Business impact scope underestimated (FR-IMPACT-001/003): the spec's "Business Impact Scope" section omits existing features/user scenarios/business rules that would be broken by this requirement, or the section is entirely absent. The reviewer must independently verify that the impact is exhaustive (cross-referencing decision-log change intent + all affected spec functionality); any underestimation is blocking and cannot be passed. This section must contain only business-level content; file paths or code symbols mixed in are subject to Spec-Purity judgment separately. **Grandfather Exception (consistent with FR-SPEC-003 legacy spec compatibility)**: this rule only applies to specs created with the new template (including the Chapter 11 skeleton); specs created before the new template was introduced are legitimately missing Chapter 11, and "section entirely absent" is not blocking for legacy specs — the criterion is: spec frontmatter/creation date predates the new template, or the spec chapters contain no trace of the Chapter 11 skeleton. New specs missing Chapter 11 are blocking.

**Acceptance Criteria Three Soft Gates (FR-ORACLE-001/002/003)**:

- **FR-ORACLE-001 Denominator Check**: Does each acceptance criterion (Success Criteria) in the spec state the denominator (i.e., "what is Y in X out of Y")? Any criterion missing a denominator (e.g., only "coverage met" without stating M out of N total) → revise_required.
- **FR-ORACLE-002 Assertion Pairing**: Does each behavioral assertion state both the positive side (X must happen) and the negative side (Y must not happen)? Any assertion with only a positive side and no negative counterpart → revise_required.
- **FR-ORACLE-003 Baseline Source Verification**: Are the sources of any baseline values or reference numbers cited in the spec stated? Implementer-supplied sources require independent confirmation (not self-certified by the same person); missing source or lack of independent confirmation → revise_required.

**Non-Blocking (should result in pass; may mark important/minor)**:

- Scope expansion ideas: "could also do X" suggestions from plan-ceo-review, placed in a minor finding with `scope_expansion: true`; does not affect verdict.
- Risk reminders for user-approved scope.
- Scenario wording could be more explicit; compatibility reservations are overly broad.
- FR numbering non-standard (not `FR-{domain-abbrev}-NNN`), FR has no scenario, insufficient user scenarios (complex needs <8, simple needs <3 key scenarios) with no reasonable explanation. Note: scenario count itself is minor; only a missing failure scenario or a missing boundary scenario (both are required) is escalated to blocking (see Exception Standard).
- Module test boundaries are slightly coarse but do not block direction judgment or plan-phase decomposition.
- Missing supplementary items in design-fidelity-component-contract: mark important per the rules below; do not block directly.

## Inspection Dimensions

| Dimension | Verification Method |
|------|---------|
| Required Skills executed | Check plan-ceo-review/review output; for UI scope check plan-design-review output. Unable to execute required skill → escalate |
| Problem statement clear | Read spec.md overview: one sentence states the user-perspective problem without embedding implementation approach |
| Original requirement coverage | Cross-reference decision-log.md; map each entry to a FR or "won't do" statement |
| Scenario coverage complete | Complex needs ≥8, simple needs ≥3 key user/boundary/failure/permission scenarios (**must include at least one failure scenario AND one boundary scenario**, missing either → blocking; insufficient count alone is minor); at least one Given/When/Then per FR |
| FR numbering standard | grep `FR-[A-Z]+-[0-9]{3}`; flat `FR-001` numbering is prohibited |
| Acceptance determinable | Success Criteria must be verifiable by command/operation/screenshot/log |
| Non-goals explicit | Out-of-scope items must not appear in FRs; scope expansion is recorded as minor only |
| Module test boundary | For needs that enter apply / land in the repo (code·UI·flow·config), each affected module has an independent test boundary sufficient to support plan-phase decomposition; discussion-only / explanation-only tasks (Ch.5 marked "not applicable this round") are not required and are not penalized for missing test boundaries |
| SPEC deviation | Apply SPEC deviation decision tree to classify: downgrade / evolution / requires human |
| AgentHub boundary | Cross-check contract.md/CLAUDE.md for RuntimeAdapter/workflow/checkpoint/Knowledge responsibilities |
| File placement | Check that repo artifacts and Knowledge artifacts have separated responsibilities |
| UI design | For UI scope: check design authorization, key states, interactions, responsiveness, interactive controls |
| Design contract | If design-fidelity-component-contract is enabled, check design-contract.md/ui-contract.json/component_candidates |
| Checkpoint | Check for explicit checkpoints, artifacts, acceptance criteria; no reliance on file watching |
| Four standard types each individually checkable (D7/D10, FR-REVIEW-005) | On the design side, delivery/exception criteria must exist as **hard line items the reviewer can check one by one** (test/code criteria are established in the plan phase). See table below for each item |
| Business impact scope exhaustiveness (D12, FR-IMPACT-003) | Read the spec's "Impact Scope" section; independently verify that all existing features/user scenarios/business rules affected by this requirement are listed (cross-reference decision-log change intent). Any omission of affected functionality → blocking. This section must be business-level only; no file paths |
| Over-specification review (KISS spec) | Check whether the spec's level of detail matches requirement complexity rather than template length. Use three spec-adapted tags (ponytail's stdlib/native are code-layer and inapplicable to a requirements spec, so dropped): `delete` (dead content: chapters/fields/scenarios no requirement asked for, written only to fill the template) / `yagni` (over-specification: entities, data lifecycle, or compatibility reservations written "for later" that this requirement does not touch) / `shrink` (verbose narrative: problem statement/background padded into a paragraph when one sentence suffices, scenarios padded to hit a count). Apply the spec Ladder per chapter (does this need to exist → already covered by decision-log/spec → would a shorter form do). Flag simplifiable spots as minor (non-blocking); but **simplification must not cut the five pillars** (FR / acceptance / impact scope / user-scenario core incl. failure & boundary scenarios / out-of-scope) — deleting pillar content for the sake of trimming → blocking. A spec already lean and accurate is explicitly cleared ("spec fits complexity, ready to proceed") |
| On-demand chapter review rule | The review core is whether the invariant is satisfied, not whether chapters are filled out. Tier-B conditional chapters (background / module split / key entities / data lifecycle / compatibility reservation) marked "not applicable this round" when their invariant is untriggered is compliant — do not penalize for "short chapter / marked not applicable". Only an **actually-triggered invariant that is omitted or treated perfunctorily** is flagged. Tier-A hard-gate five chapters missing or perfunctory → blocking as usual |

## Four Standard Types — Inspection Dimensions (Design-Side Hard Checkable Items)

> Delivery/exception/test/code standards do not each get a separate major section. The design phase only carries **delivery (acceptance)** and **exception (boundary scenarios)** as hard, individually checkable items; test dual-column commands and code standards are established in the plan phase (see plan-reviewer-contract). Each item has a pass/fail criterion; check each one individually — any unsatisfied hard item → blocking.

| Type | Hard Checkable Items | pass/fail Criterion |
|----|---------------|----------------|
| **Delivery Standard (done)** | Each FR's Success Criteria can be checked individually (verifiable by command/operation/screenshot/log/manual step), not a vague "looks correct" description | Each Success Criteria is objectively determinable → pass; any subjective or unverifiable acceptance criterion → blocking |
| **Exception Standard (boundary)** | spec explicitly lists failure/boundary/permission scenarios (complex needs ≥8 scenarios, simple needs ≥3 key scenarios, **regardless of simple or complex must include at least one failure AND one boundary scenario**); each has a Given/When/Then | Key failure/boundary scenarios present and verifiable → pass; only happy path covered, missing failure or boundary scenario → blocking (relaxed count does not exempt the "must have failure/boundary" hard floor) |

## Spec-Purity Blacklist

| Category | Prohibited Content | Example | Verification Method |
|------|---------|------|---------|
| Absolute file paths | Paths starting with `/` (user/temp paths) | `/Users/...`, `/tmp/...` | grep for path |
| Hook event strings | PreToolUse, PostToolUse, SessionStart | `SessionStart hook` | grep for event names |
| TS type field definitions | `interface` / `type` / field definitions | `interface X {` | grep for TS syntax |
| Shell command lines | capture-phase-evidence.sh (agenthub platform path; not in the standalone repo) collection | `apply/evidence/phase-{N}-{MODE}.json` (agenthub platform path; not in the standalone repo) | read the command field |

## UI and Design Contract Rules

When UI is in scope:

- design-review only checks whether the spec proposes UI acceptance criteria; the 6 visual contract dimensions are inspected by plan-review.
- No design materials/authorization yet proceeding to implementation → blocking.
- `design-contract.md` must be under `docs/contracts/`; `ui-contract.json` must list the page state/elements involved in this change.
- Elements/states with `truth_source: "manual_added"` are legitimate, but must be built on top of the extractor-generated baseline contract.
- When `component_candidates` overlap with the change scope, the review must annotate each as adopted/not adopted.
- The contract source should be the formal extractor `generateMarkdown()`; manually added sections require a `manually added` or `source: plan.md` marker.
- Any of the above design contract deficiencies or errors → `important` with a `requiredFix`; escalate to blocking only if it would make UI acceptance impossible.

## Knowledge Path Rules

- Correct project root: `{{task_tracking_root}}`.
- Task files are located at `{{task_tracking_root}}/tasks/{task-id}/`.
- Do not treat `specs/{feature}/spec.md` in the repo as a Knowledge task directory.

## Verification Methods

1. **Read files**: Read decision-log.md, SPEC.md, constitution, spec.md, contract.md, CLAUDE.md.
2. **Skill cross-check**: Verify one by one that each plan-ceo-review/review/plan-design-review finding has been incorporated into the verdict; required skill not genuinely invoked → escalate.
3. **grep verification**: FR numbering, blacklist, Knowledge paths, key acceptance criteria fields.
4. **Cross-reference**: When SPEC/constitution/contract and spec.md are inconsistent, apply the decision tree to determine severity.
5. **Manual judgment**: Problem statement, scope, and module boundaries must be supported by specific rationale and evidence.

## Same Finding Escalation Rule for 2 Consecutive Rounds (FR-REV-001)

When the same blocking finding remains unclosed for 2 consecutive rounds, the finding must include:

1. Root cause.
2. Scan scope.
3. Counter-example matrix.
4. Closure checklist.

Still unclosed in round 3 → `escalate_to_human`.

## Revision Log

After receiving `revise_required` and before initiating the next review round, the main agent must append-only record: the failure root cause, modified files, change summary, verification commands, and results. The reviewer reads only; treating a missing revision log as missing evidence.
