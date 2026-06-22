# Pass-evidence contract (authoritative)

> Single source of truth for the three fields a `pass` verdict must carry. SKILL.md and the READMEs link here instead of restating the rules. The runtime implementations (`standalone.sh`, `examples/codex-runner.sh`, `reviewer-prompt-assembly.md`) are listed at the bottom — when they and this file disagree, this file is the spec and the code is the bug.

A `verdict: "pass"` is a *claim*, and a claim must carry evidence. Three fields make a pass auditable. Two are objective (facts about what was reviewed); one is subjective (the reviewer's judgement) and is **never** auto-filled — backfilling a judgement would be forgery.

## The three fields

| Field | Kind | Shape | Required form |
|---|---|---|---|
| `reviewSnapshot[]` | objective (coverage-bearing) | array of `{ path, gitHead, mtime, hash }` per reviewed file | **non-empty array** |
| `worktreeInventory` | objective (not a coverage claim) | `{ included[], unrelated[], excluded[] }` | object with all three arrays present |
| `riskDisposition[]` | **subjective** | array of `{ risk, checkedSource, decision, whyNotBlocking }` per high-risk item | array — **empty `[]` is valid** when there were no high-risk items |

## What "enforced" means

Enforcement checks the fields are **present and well-formed** — it does *not* judge whether the reviewer covered every risk correctly. That correctness is the reviewer's job, not the gate's. Specifically a pass is rejected unless:

- `reviewSnapshot` is a non-empty array,
- `riskDisposition` is an array (empty allowed), and
- `worktreeInventory` is an object carrying `included` / `unrelated` / `excluded` arrays.

A pass missing or malforming any of these **fails fast to escalation** — it does not slip through as a pass.

## Backfill rules differ by path

This is the one subtlety worth keeping straight. The two entrypoints handle a *missing* field differently:

| | **standalone** (`standalone.sh`) | **gated platform** (agenthub persist layer) |
|---|---|---|
| `reviewSnapshot` | never backfilled — the runner must supply it; missing → fail fast | may be backfilled *only if* the reviewer's `finalVerifierReadSet` exists (paths derived from it, hashes from disk); otherwise fail fast |
| `worktreeInventory` | never backfilled — missing → fail fast | may be backfilled from `git status` |
| `riskDisposition` | **never backfilled** | **never backfilled** (subjective → backfill = forgery) |

The shared, non-negotiable rule across both paths: **`riskDisposition` is never auto-filled.** In standalone, *nothing* is auto-filled — the runner owns all three (this is why `examples/codex-runner.sh` deliberately does not backfill).

All three fields live outside the `verdict-core-hash` whitelist, so a permitted backfill on the gated path does not break the `_execNonce` tamper-evidence check (see [exec-proof.md](./exec-proof.md)).

## Authoritative implementations

- standalone enforcement: `standalone.sh` (the pass-fields check after verdict extraction).
- reviewer instruction / binding: [reviewer-prompt-assembly.md](./reviewer-prompt-assembly.md) ("Pass evidence binding").
- example runner that produces these fields: [`../examples/codex-runner.sh`](../examples/codex-runner.sh).
