# Review Input — rename-compat

## Context

Task: generalization-of-review-skills
Stage: apply / phase-1
Review type: 3rd-review (code review)

## Change Summary

Renames the skill directory `review-dispatch/` to `3rd-review/` and adds a
compatibility symlink `review-dispatch -> 3rd-review` so existing callers
continue to work without modification.

## Diff

```diff
# New directory: packages/core/agenthub/skills/3rd-review/
# (contents identical to former review-dispatch/)

# Symlink created:
# packages/core/agenthub/skills/review-dispatch -> 3rd-review

--- a/packages/core/agenthub/skills/review-dispatch/SKILL.md
+++ b/packages/core/agenthub/skills/3rd-review/SKILL.md
@@ -1,2 +1,3 @@
-# review-dispatch
+# 3rd-review (formerly review-dispatch)
+<!-- Backward-compat symlink: review-dispatch -> 3rd-review -->
 Dispatches review requests to sub-reviewers and aggregates verdicts.
```

## Required Artifacts

- 3rd-review/ directory created with all original contents ✓
- Symlink review-dispatch -> 3rd-review created ✓
- SKILL.md updated with new name ✓
- Existing callers (referencing review-dispatch) verified to resolve via symlink ✓

## Evidence

- RED: test with old path `review-dispatch/SKILL.md` fails before symlink creation
- GREEN: test with old path succeeds after symlink creation (symlink resolution confirmed)
- find -L confirms both paths resolve to same SKILL.md
