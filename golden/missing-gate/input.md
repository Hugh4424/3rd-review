# Review Input — missing-gate

## Context

Task: generalization-of-review-skills
Stage: apply / phase-2
Review type: 3rd-review (code review)

## Change Summary

Implements a new `resolveProvider()` function that detects whether the current
environment has agenthub available, falling back to standalone mode.

## Diff

```diff
--- a/packages/core/agenthub/workflow-engine/resolve-provider.ts
+++ b/packages/core/agenthub/workflow-engine/resolve-provider.ts
@@ -0,0 +1,12 @@
+export type Provider = 'agenthub' | 'standalone';
+
+export function resolveProvider(): Provider {
+  if (process.env.AGENTHUB_TASK_DIR) {
+    return 'agenthub';
+  }
+  return 'standalone';
+}
```

## Required Artifacts

- resolve-provider.ts added ✓

## Evidence

- (No RED evidence: no failing test shown before implementation)
- (No GREEN evidence: no passing test shown after implementation)
- The submitter claims "tests pass" but provides no test output or test file reference
