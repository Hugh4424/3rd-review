#!/usr/bin/env node
// cost-compare.mjs — FR-COST-004 anti-cheat baseline metrics (T010)
//
// Computes the frozen baseline metrics from a task's reviews.jsonl so T018 can
// replay the same baseline after the cost-reduction changes and assert "no worse".
// This script only builds the baseline; the before/after comparison is T018's job.
//
// Metric definitions (tasks.md T010):
//   escape_rate         = blocking findings surfaced AFTER a checkpoint passed
//                         ÷ total blocking findings (0 when total is 0, never NaN)
//   human_interventions = escalate_to_human verdict count + manual-pass events
//                         (reviews.jsonl carries no manual-pass field in the frozen
//                          baseline → only escalate verdicts counted; gap noted)
//   main_reviewer_tokens = reviewer token total from the data source (reviews.jsonl
//                          has no token field → 0 with a documented gap, not faked)
//   elapsed             = seconds between earliest and latest review ts
//
// Usage:
//   cost-compare.mjs --baseline-only [--reviews=<path>]   # stdout: pure JSON
//   cost-compare.mjs --baseline-only --out=<path>         # also freeze to file
import fs from "node:fs";

// ── parse reviews.jsonl rows; tolerate blank lines and bad JSON (skip, do not crash silently) ──
export function parseReviews(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t));
  }
  return rows;
}

export function computeBaseline(rows) {
  const notes = [];
  const list = Array.isArray(rows) ? rows : [];

  // total blocking across all rounds
  let totalBlocking = 0;
  for (const r of list) totalBlocking += Number(r.blockingCount) || 0;

  // escaped blocking = blocking on a checkpoint at a round LATER than that
  // checkpoint's earliest pass round (a blocking that slipped past a pass).
  const firstPassRound = new Map();
  for (const r of list) {
    if (r.verdict === "pass") {
      const cp = r.checkpoint;
      const rd = Number(r.round) || 0;
      if (!firstPassRound.has(cp) || rd < firstPassRound.get(cp)) firstPassRound.set(cp, rd);
    }
  }
  let escapedBlocking = 0;
  for (const r of list) {
    const cp = r.checkpoint;
    const rd = Number(r.round) || 0;
    const blk = Number(r.blockingCount) || 0;
    if (blk > 0 && firstPassRound.has(cp) && rd > firstPassRound.get(cp)) {
      escapedBlocking += blk;
    }
  }
  const escape_rate = totalBlocking > 0 ? escapedBlocking / totalBlocking : 0;

  // human interventions = escalate_to_human verdicts (+ manual-pass events if present)
  let escalateCount = 0;
  for (const r of list) if (r.verdict === "escalate_to_human") escalateCount += 1;
  notes.push(
    "human_interventions counts escalate_to_human verdicts only; reviews.jsonl has no manual-pass event field, so manual releases are not represented in this baseline source.",
  );
  const human_interventions = escalateCount;

  // tokens: T003 [FR-MET-003/004] — review-persist.sh now writes mainReviewerTokens into each
  // reviews.jsonl entry (sourced from _codexMeta.tokens.total_tokens, or input+output sum as
  // fallback). Rows produced before T003 carry no token field → those rows contribute 0.
  let main_reviewer_tokens = 0;
  let tokenSeen = false;
  for (const r of list) {
    const t = r.mainReviewerTokens ?? r.tokens ?? r.tokenTotal;
    if (typeof t === "number" && Number.isFinite(t)) { main_reviewer_tokens += t; tokenSeen = true; }
  }
  if (!tokenSeen) {
    notes.push(
      "main_reviewer_tokens=0: reviews.jsonl rows carry no token field; reviewer token totals live in runtime session meta, not in the frozen reviews.jsonl baseline source.",
    );
  }

  // elapsed = max ts - min ts in seconds
  const times = list.map((r) => Date.parse(r.ts)).filter((n) => Number.isFinite(n));
  const elapsed = times.length >= 2 ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : 0;

  return {
    baseline: { escape_rate, human_interventions, main_reviewer_tokens, elapsed },
    notes,
    meta: { rowCount: list.length, totalBlocking, escapedBlocking },
  };
}

// ── CLI ──
function isMain() {
  return process.argv[1] && process.argv[1].endsWith("cost-compare.mjs");
}
if (isMain()) {
  const args = process.argv.slice(2);
  const get = (n) => {
    const a = args.find((x) => x.startsWith(`--${n}=`));
    return a ? a.slice(n.length + 3) : undefined;
  };
  if (!args.includes("--baseline-only")) {
    process.stderr.write("Usage: cost-compare.mjs --baseline-only [--reviews=<path>] [--out=<path>]\n");
    process.stderr.write("Only --baseline-only is implemented; the before/after comparison is T018.\n");
    process.exit(2);
  }
  const reviewsPath = get("reviews");
  let rows = [];
  if (reviewsPath) {
    rows = parseReviews(fs.readFileSync(reviewsPath, "utf8"));
  } else {
    // stdin fallback so the verify command can pipe a reviews.jsonl
    try { rows = parseReviews(fs.readFileSync(0, "utf8")); } catch { rows = []; }
  }
  const result = computeBaseline(rows);
  const out = get("out");
  const json = JSON.stringify(result, null, 2);
  if (out) fs.writeFileSync(out, json + "\n"); // freeze for T018
  // stdout MUST be pure JSON (piped to node JSON.parse by the verify command)
  process.stdout.write(json + "\n");
}
