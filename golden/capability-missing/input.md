# Review Input — capability-missing

## Context

Task: generalization-of-review-skills
Stage: apply / phase-4
Review type: 3rd-review (code review)

## Change Summary

This change requires the reviewer to execute a live integration test against
a production database to verify the migration is safe. The reviewer must:
1. Connect to prod DB and run EXPLAIN ANALYZE on the new query
2. Compare query plan against the pre-migration baseline stored in an external
   Grafana dashboard (requires VPN + Grafana API token)
3. Only pass if p99 latency stays under 50ms

## Diff

```diff
--- a/server/internal/handler/issues.go
+++ b/server/internal/handler/issues.go
@@ -112,6 +112,14 @@ func (h *Handler) ListIssues(w http.ResponseWriter, r *http.Request) {
+    // New: filter by assignee_type for performance
+    if params.AssigneeType != "" {
+        q = q.Where("assignee_type = ?", params.AssigneeType)
+    }
```

## Required Artifacts

- issues.go updated ✓
- Grafana baseline dashboard: (external, requires VPN access — not attached)
- EXPLAIN ANALYZE output: (requires prod DB access — not available to reviewer)

## Evidence

- Reviewer cannot access production database
- Reviewer cannot access Grafana dashboard (VPN required, credentials not provided)
- No staging environment query plan provided as substitute
