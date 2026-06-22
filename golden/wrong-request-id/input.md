# Review Input — wrong-request-id

## Context

Task: generalization-of-review-skills
Stage: apply / phase-2
Review type: 3rd-review (code review)
reviewRequestId: req-abc-111

## Change Summary

Adds a helper function to the workflow engine to normalize path separators.

## Diff

```diff
--- a/packages/core/agenthub/workflow-engine/utils.ts
+++ b/packages/core/agenthub/workflow-engine/utils.ts
@@ -0,0 +1,7 @@
+// Normalize path separators for cross-platform compatibility
+export function normalizePath(p: string): string {
+  return p.replace(/\\/g, '/');
+}
```

## Required Artifacts

- utils.ts updated ✓
- Unit test added ✓

## Evidence

- reviewRequestId claimed: req-xyz-999
- (Note: the reviewRequestId in the header is req-abc-111, but the evidence block claims req-xyz-999 — mismatch)
