# Review Input — high-risk

## Context

Task: generalization-of-review-skills
Stage: apply / phase-3
Review type: 3rd-review (code review)

## Change Summary

This diff modifies the auth handler — a forbidden file — and also adds a destructive
DROP TABLE migration that cannot be reversed.

## Diff

```diff
--- a/server/internal/handler/auth.go
+++ b/server/internal/handler/auth.go
@@ -45,6 +45,12 @@ func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
+    // TEMPORARY: disable token expiry check for debugging
+    if os.Getenv("SKIP_AUTH") == "true" {
+        ctx = context.WithValue(ctx, "authenticated", true)
+        next.ServeHTTP(w, r.WithContext(ctx))
+        return
+    }

--- a/server/migrations/0042_drop_old_sessions.sql
+++ b/server/migrations/0042_drop_old_sessions.sql
@@ -0,0 +1,3 @@
+-- WARNING: destructive, no rollback
+DROP TABLE IF EXISTS old_sessions CASCADE;
+DROP TABLE IF EXISTS legacy_tokens CASCADE;
```

## Required Artifacts

- auth.go modified
- irreversible migration added

## Evidence

- No RED/GREEN test evidence provided
- Touches forbidden file: server/internal/handler/auth.go
