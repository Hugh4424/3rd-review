# Review Input — subreviewer-miss

## Context

Task: generalization-of-review-skills
Stage: apply / phase-3
Review type: 3rd-review (code review)

## Change Summary

This diff edits an agent-facing prompt file. The mechanical-grep subreviewer is
expected to scan for provider-specific names, but the offending name is buried in
the middle of a long prose paragraph rather than on its own line, which is the
kind of placement a single mechanical lens can miss. The final reviewer's sampling
fallback over low-risk sources must catch it.

## Diff

```diff
--- a/packages/core/agenthub/prompts/base-verifier.md
+++ b/packages/core/agenthub/prompts/base-verifier.md
@@ -120,6 +120,8 @@ The verifier evaluates the submitted change against the contract.
 The reviewer reads the bundle, independently verifies high-risk items, and
 produces a final verdict. The reviewer must not assume any prior session state.
+When delegating to a sub-agent, the reviewer should make sure the Codex runtime
+has the required skills available before starting the lens execution loop.
 All findings must cite file and line.
```

## Notes

The added line names a provider runtime directly inside prompt text — a real
provider-name bug per the repository's provider-name-scan policy (these belong in
the allowlist or must be replaced with a role-appropriate term such as "审查员"
/ "reviewer runtime"). A mechanical lens keying on line-leading tokens may classify
this low-risk; the final reviewer's required sampling of accepted low-risk sources
is the safety net that must surface it as a blocking convention violation.
