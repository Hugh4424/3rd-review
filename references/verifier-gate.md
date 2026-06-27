# Reviewer Verification Gate (bypass-resistant, FR-REVIEW-012)

> This file is referenced by the 3rd-review SKILL.md thin shell; the main session does not read it. Reviewers/scripts/gate read on demand.

## Reviewer Verification Gate (bypass-resistant)

The reviewer_output gate cross-checks review execution evidence against the reviewer-proof registry. **Known architectural limitation (FR-REVIEW-012)**: both the codex and claude paths use global directory scanning; the main agent's own session can satisfy the binding, so orchestrator fabrication cannot be prevented. Therefore:

- **Path 1+2 (codex / claude, registered verifiers)**: verification failure is a non-blocking diagnostic (`console.warn`; workflow continues).
- **Path 3 (unknown provider, no registered verifier)**: `exit 2` fail-closed is retained — this is a genuine config error, not a tamper-proofing gap.

The only genuine machine-enforced tamper-proof mechanism is the AJV schema (constraint 3). drift detection 见 scripts/verify-snapshot-manifest.mjs；见 FR-FORGE-001。
