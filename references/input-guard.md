# Input Guard (D17)

> This file is referenced by the 3rd-review SKILL.md thin shell. The main session does not read it; reviewers / scripts read it on demand.

Input sufficiency must be assessed before a review starts. Missing categories must be flagged and inferences must be echoed back for confirmation. Silent review initiation under insufficient information is not permitted:

1. **Sufficiency check**: Determine whether the review input contains the minimum set required for a verdict (the subject under review in full or as a diff, context, and change intent). A code-review requires at least a diff or a list of changed files; a design/plan review requires at least the document under review.
2. **Missing-category feedback**: For each missing category, explicitly state what is absent (e.g. "diff missing — cannot perform code review"). Do not fill gaps by guessing.
3. **Inference echo-back**: When the review type or scope is inferred from the input (e.g. contentType inferred from file extension), echo the inference back to the caller for confirmation rather than adopting it silently.
4. **Insufficient and unresolvable input** → `escalate_to_human`; stderr must explain what is missing and what the next step is.
5. **When a review finding causes any original requirements-ledger entry to be discarded**, the discard reason must be logged. A missing reason has mandatory blocking force on the verdict.
