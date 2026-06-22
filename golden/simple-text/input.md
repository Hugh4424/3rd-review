# Review Input — simple-text

## Context

Task: generalization-of-review-skills
Stage: apply / phase-1
Review type: 3rd-review (code review)

## Change Summary

This is a minor documentation update. The following diff adds a one-line clarification
to the README of the `review-dispatch` skill.

## Diff

```diff
--- a/packages/core/agenthub/skills/review-dispatch/SKILL.md
+++ b/packages/core/agenthub/skills/review-dispatch/SKILL.md
@@ -1,3 +1,4 @@
 # review-dispatch
+<!-- Standalone mode: run without agenthub gate/journal -->
 Dispatches review requests to sub-reviewers and aggregates verdicts.
```

## Required Artifacts

- SKILL.md updated ✓
- No functional code changed
- No forbidden files touched

## Evidence

- RED phase: N/A (documentation only)
- GREEN phase: N/A (documentation only)
- Scope: 1 file, 1 line added (comment only)
