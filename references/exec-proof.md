# Review Execution Proof (tamper-evident, not tamper-proof)

> This file is referenced by the 3rd-review SKILL.md thin shell; the main session does not read it. Reviewers/scripts/gate read on demand.

## Review Execution Proof (tamper-evident, not tamper-proof)

The three layers below are mechanisms for detecting the trustworthiness of an execution's provenance. **Under a single-process shared-shell architecture, fabrication cannot be eliminated** — the main agent has write access to disk and can therefore simulate nonces, mine hashes, and write to the ledger. This is therefore **evidence hardening**, not **tamper-proofing**; genuine tamper-proofing requires process isolation / privilege separation (future story).

**Bypass event (2026-06-12)**: the orchestrator (main agent skill) manually authored a review JSON and used `--delegated-precheck=off` to skip the execution-layer validation. This bypass injected 5 `BYPASS` entries into workflow-issues.jsonl (issue-id: bypass-exec-nonce-phase6c-1~5). Neither the gate layer nor the persist layer detected it.

**1. `_execNonce` + `reviewRecordHash` dual-field mechanism (added in Phase 6c, machine-enforced at the gate layer)**

`adapter review exec` populates `_execNonce` (random 16-byte hex) in the result-file on output, and simultaneously writes the nonce + reviewRecordHash (SHA256 of the core review fields, computed by `scripts/verdict-core-hash.mjs`) into the `.machine/source/.exec-nonces.jsonl` ledger. The gate layer (`validateExecProvenance` in `workflow-gate.ts`) performs NOT-gate validation at two points:

- **reviewer_output gate** (first pass, `consumeNonce=false`): checks that the report has `_execNonce`, that the ledger can match it, and that the hash is consistent. Missing or mismatched → `exit 2` BLOCKED.
- **post_review_pass gate** (before advancing after pass, `consumeNonce=true`): reloads round-N.json → repeats the above validation + marks the nonce as consumed (`.exec-nonces-consumed.jsonl`). Duplicate nonce consumption → `exit 2` BLOCKED (replay detection).

`intake-text reviewMode` is exempt (missing `_execNonce` does not block).

**2. The only legitimate input at the gate layer is `adapter review` (the atomic exec+persist chain)**

The only way to bypass this layer also requires going through adapter exec — the only entry point that generates a legitimate entry in the "nonce ledger" is a subprocess call from the adapter. If the main agent manually authors a report and then directly calls `gate.sh reviewer_output --file=...`, it will be blocked at phase one (`_execNonce` missing), unless it simultaneously forges the ledger (which falls back to the "single-process shared shell" ceiling described above).

However, the following situations **do not trigger** ledger validation:
- **Known architectural limitation**: the single-process shared shell described above — the main agent can simultaneously write the gate's report file and the `.machine/source/.exec-nonces.jsonl` ledger, and can simulate both `_execNonce` and the hash. This layer is effective against an honest agent; it is not effective against a malicious agent.
- **Bypass event (2026-06-12)**: the orchestrator skipped the persist step and went directly from `adapter review exec --delegated-precheck=off` output → `reviewer_output` → `post_review_pass`, bypassing the atomic persist chain. This path has since been closed (after adding pnpm filter to `adapter review exec`), but this record is retained as a design lesson.

**3. AJV / schema validation is fail-closed, no retry (retained)**

`review-persist.sh:256` (agenthub platform path; not in the standalone repo): schema validation failure → `process.exit(2)`, immediate exit, no automatic retry. The reviewer's output JSON structure must be fixed and then the full flow re-run as a foreground exec. This is currently the only universal machine-enforcement layer (because schema does not depend on execution-chain information).

---
