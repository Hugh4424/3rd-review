# Off-Platform Usage (D12)

> This file is referenced by the 3rd-review SKILL.md thin shell. The main session does not read it; the standalone entry point / sub-agents read it on demand.

The core capability of this skill is **independent, adversarial code/document review**, not tied to the agenthub workflow. Both usage modes share the same review strategy (SKILL.md + references/) and verdict scripts; only the environmental differences are captured in two thin adapter entry points:

- **Inside agenthub (gated)**: The main agent is triggered via `checkpoint_request`, routed through `review-dispatch-adapter.sh` (agenthub platform path; not in the standalone repo), persisted into the task directory, and validated by the gate.
- **Off-platform (standalone)**: Like asking a colleague to review your code or documentation in a clean environment — no gate, no journal, no reviewRequestId binding. Entry point is `./standalone.sh` (root of the standalone open-source repo; inside the agenthub monorepo this corresponds to `skills/3rd-review/standalone.sh`) (RD-4). Output lands in `<output-root>/tasks/<name>/`; the verdict JSON is marked `provenance: "single-context"` (a standalone verdict must not be copied back into agenthub to serve as a gated verdict — it will be rejected by the `reviewer_output` anti-spoofing assert).
