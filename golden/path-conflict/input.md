# Review Input — path-conflict

## Context

Task: generalization-of-review-skills
Stage: apply / phase-3
Review type: 3rd-review (code review)

## Change Summary

Adds a standalone output directory structure. However, the proposed output path
`tasks/generalization-of-review-skills/` conflicts with an existing active
worktree checkout at the same path.

## Diff

```diff
--- a/packages/core/agenthub/skills/review-dispatch/scripts/standalone.sh
+++ b/packages/core/agenthub/skills/review-dispatch/scripts/standalone.sh
@@ -12,6 +12,7 @@ TASK_NAME="${1:-unnamed-task}"
+OUTPUT_DIR="$(pwd)/tasks/${TASK_NAME}"
+mkdir -p "${OUTPUT_DIR}/reviews"
+mkdir -p "${OUTPUT_DIR}/artifacts"
```

## Conflict Details

- Existing worktree at: `/Users/user/projects/multica-worktrees/generalization-of-review-skills/`
  maps to the same effective path as the proposed `tasks/generalization-of-review-skills/`
  when run from the worktree root.
- Two writers (standalone script + active agenthub worktree) would race on
  `tasks/generalization-of-review-skills/reviews/` — reports could overwrite each other.

## Evidence

- Conflict detected: yes
- Proposed mitigation: none provided
