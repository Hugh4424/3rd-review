<div align="center">

# 🔍 3rd-review

### Independent, cross-source code review that an AI agent can't fake its way past.

*Claude reviewing Claude always passes. That pass is worthless. This fixes it.*

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

---

## The problem in one sentence

When an AI agent reviews its own work, it inherits its own blind spots — so it almost always says "looks good." A green checkmark from the same model that wrote the code is **theater, not a quality gate.**

`3rd-review` makes review *independent by construction*: a **different** engine (e.g. `codex`, `gemini`) — or at minimum a fresh, context-isolated sub-agent — produces the verdict. The author never grades their own paper.

> Real case from our logs: a change that the author had **already self-reviewed as `pass`** took a cross-source reviewer **6 rounds** to actually clear — findings went `5 → 2 → 1 → 1 → 1 → 0`, exposing a CI that failed *open*, a push path that bypassed the gate, and a schema that didn't even match. `verdict=pass` from a self-review meant *nothing*.

---

## Why you'd want this

| You have… | Without 3rd-review | With 3rd-review |
|---|---|---|
| An agent that writes + reviews its own code | Self-pass, blind spots inherited | Verdict from an **independent** engine |
| Big mechanical diffs | One reviewer reads everything, burns tokens | Heavy parts fan out to **sub-reviewers** |
| Small doc tweaks | Full third-party review, overkill | Auto-downgrades to a cheap *isolated* same-source review |
| A reviewer that keeps nitpicking forever | Endless revise loop | **Drift-aware** escalation to a human |
| An agent that hand-writes a fake review JSON | Gate waves it through | **Tamper-evident** exec proof catches it |

---

## The core idea: review is a *cost gradient*, not a single hammer

The biggest design insight — learned the hard way — is that **a sub-agent is not "stronger" review. It's *cheaper* review.** Independence is the floor; cost is the dial.

So every review is routed to one of three tiers, picked automatically from content type, scope, and risk:

```
        more independent / more expensive
  ▲
  │  R1  cross-source + sub-reviewers   ← large diffs, lots of mechanical reading
  │      (external engine drives, sub-agents read the bulk in parallel)
  │
  │  R2  cross-source, single reviewer  ← medium code / plans / designs
  │      (one external engine, e.g. codex)
  │
  │  R6  same-source clean sub-agent    ← docs-only, tiny changes, or no external CLI
  ▼      (fresh isolated context — still independent, just same model)

        cheaper / lighter
```

**Hard floor — never downgraded, no matter what:** anything touching `auth` / `migration` / `delete` keywords + real code diff + changes to critical process rules is *forced* to the heaviest tier on the first round. Risk only ever pushes routing **up**.

The routing logic lives in a **pure function** (`scripts/route-review.mjs`) reading a **single data table** (`config/route-rules.json`) — same input, same output, no hidden host state. The thin SKILL.md shell never restates the thresholds, because prose that duplicates code always drifts out of sync with it.

---

## Two ways to run it

```
                    ┌─────────────────────────────┐
   bound to a       │  gated adapter (in-platform)│   verdict persisted to task dir,
   live task?  yes ─►  review-dispatch-adapter.sh  │   checked by downstream gates
                    └─────────────────────────────┘
        │ no
        ▼
   ┌──────────────────────┐
   │  standalone.sh        │   clean room: review any code/docs,
   │  (off-platform)       │   no gate, no journal, exit-code contract
   └──────────────────────┘
```

The **standalone** entrypoint is the one most people want — point it at a file or a diff and get an independent verdict back.

> **Prerequisite (read this before your first run):** `standalone.sh` needs a *review runner* — the command that actually drives the reviewing engine. Inside the agenthub platform this is wired up automatically via `review-dispatch-adapter.sh`. In a plain GitHub checkout that adapter isn't shipped, so you **must** pass your own runner with `--review-runner`, otherwise the run escalates to a human on the spot.

```bash
# Standalone checkout: pass your own review runner (any command that reads the
# prompt and returns a verdict JSON — e.g. a codex/gemini wrapper).
./standalone.sh \
  --input=my-change.diff \
  --output-root=./reviews \
  --review-runner='your-review-runner-command'

# Exit-code contract:
#   0 = pass            2 = escalate_to_human
#   1 = revise_required other = execution error
```

Both entrypoints share **one** review strategy and **one** set of decision scripts. Only the environment differences (gate vs. no-gate, journal vs. no-journal) live in the two thin adapters. Note: `review-dispatch-adapter.sh` is the **in-platform** adapter used inside agenthub — it is not part of this standalone repo.

---

## What makes the verdict trustworthy

A `pass` is not the finish line, and it's not free to claim. Three things keep it honest:

**1. Independence is non-negotiable.** The final verdict *must* come from an isolated context. The main agent grading its own work is the exact failure this whole tool exists to prevent.

**2. A `pass` must carry evidence.** Every `pass` ships three fields:
- `reviewSnapshot[]` — `path / gitHead / mtime / hash` for every file reviewed (objective coverage proof; the persistence layer *may* backfill it from the verifier read-set).
- `worktreeInventory` — `included / unrelated / excluded` paths (objective; may be backfilled from `git status`).
- `riskDisposition[]` — for each high-risk item: `risk / checkedSource / decision / whyNotBlocking`. This one is **subjective and never backfilled** — the reviewer *must* produce it, and a `pass` that's missing it fails fast. Backfilling a subjective judgement would be forgery, so the pipeline refuses to.

**3. Tamper-evident execution proof.** Each genuine review run stamps an `_execNonce` + `reviewRecordHash` into an append-only ledger. The gate cross-checks them, and a consumed nonce can't be replayed. *(Honest about its own limits: in a single-process shared shell this is **tamper-evident, not tamper-proof** — a truly malicious agent with disk access could forge the ledger. Real anti-forgery needs process isolation. We don't pretend otherwise.)*

---

## Hard rails that no routing tier can bypass

1. **Minimum regression coverage** — every round covers ≥80% of changed lines in the phase.
2. **High-risk dimensions get full review** — never sampled, never downgraded.
3. **Narrow scope fails to full scope** — if any rail isn't met under a reduced-scope review, fall back to full scope *immediately*.
4. **Independence guarantee** — final verdict must come from an independent context. No self-review, ever.

---

## The escalation problem nobody warns you about

We didn't cap review rounds with a fixed number, and we learned *why* the hard way.

Naïve circuit-breakers fail to **target drift**: when an agent's blocking finding hops domain every round — compile error → path → scope → provenance → contract → schema — a "same blocking finding repeated N times" breaker *never trips*. The salami-slicing revise loop slips right through the design gap.

> Measured: one checkpoint ran **13 rounds, 0 passes, ~80 minutes burned.** And a too-eager downgrade rule that re-escalated to the most expensive tier the moment a cheap round found ≥1 blocking finding caused a strict **R6 ↔ R1 sawtooth — 46% of rounds still ran the most expensive mode.**

So escalation is **drift-aware**: it triggers on a repeated *unresolved* finding *accumulating toward a threshold*, recognizes salami-slicing where the bar moves every round, and degrades by **finding count + severity** — not by a fixed cap or a keyword allow/deny list. *Total cost = cost-per-round × rounds; runaway round-count burns more than an expensive single round, so fix the loop before you optimize the round.*

---

## Things we got wrong first (so you don't have to)

This tool is the residue of a lot of bruises. A few that shaped the design:

- **"Off-platform review kept silently picking the cheap same-source tier."** Root cause was three-layered: the shell conflated *"which entrypoint"* with *"which review method"* (they're **orthogonal**); the agent fed a *prose description* instead of a real diff (correctly classified as a tiny text record → cheap tier); and the environment probe never actually checked whether `codex` was installed. **Lesson baked in: always probe `command -v codex` first, and always feed a *real diff* — never "please review my XYZ plan" in natural language.**

- **The expensive part of a review wasn't the finding — it was the re-reading.** We profiled one real `codex` pass round: **343s, 1.25M tokens, 44 commands.** Of 24 file reads, **9 were re-reading fixed protocol files that never change within a task** (CLAUDE.md, contracts, schemas — 220–260 lines each, re-read every round). A zero-finding `pass` round cost the same as a `revise` round, because protocol re-reading was decoupled from whether there was anything to find. **Lesson: judge ROI by profiling the actual session, never by gut feel.**

- **A "stronger means more sub-agents" instinct.** Wrong. Hand all context to one external reviewer and the sub-agents save nothing. The win only lands when each sub-agent reads its *own* assigned files and returns a summary.

---

## Repository layout

```
SKILL.md                  # the thin shell the main agent reads (skeleton only)
standalone.sh             # off-platform entrypoint (the one you probably want)
scripts/
  route-review.mjs        # pure-function router — the brain
  verdict-core-hash.mjs   # tamper-evident hashing
  ...                     # cost compare, replay diff, report render, ...
config/
  route-rules.json        # the single source of truth for thresholds
references/               # detailed rules, loaded on-demand by sub-agents/scripts
golden/                   # golden input→expected fixtures for the router
__fixtures__/             # finding-classification + pass-coverage fixtures
```

The architecture is deliberate: **the main agent reads only the thin shell.** Every detailed rule lives in `references/` and is pulled in on demand by the sub-agents and scripts that actually need it — so the orchestrating context never bloats.

---

## Design philosophy, in four lines

- **Independence is the floor, cost is the dial.** A cheap review is fine; a self-review is not.
- **Risk only routes up.** When in doubt, review harder.
- **Code owns the thresholds; prose owns the intent.** Prose that restates code drifts from it.
- **A `pass` is a claim that must carry evidence** — snapshot, risk disposition, inventory, and a nonce that can't be replayed.

---

<div align="center">

*Built from the scar tissue of a real multi-agent development pipeline.*
*Honest about what it can and can't guarantee.*

</div>
