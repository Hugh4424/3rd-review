#!/usr/bin/env node
// ac1-acceptance.test.mjs — T2-7: AC-1 performance thresholds
//
// (a) Wall-clock: full runReview() with golden diff must complete ≤120s
// (b) Token tri-state:
//     - present AND ≤300000 → pass
//     - present AND >300000 → fail
//     - absent/unknown → inconclusive-token (exit 1, log to references/)

import { runReview } from "./run-heterologous-review.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const GOLDEN_DIFF = path.join(__dirname, "..", "golden", "simple-text", "input.md");
const LOG_DIR = path.join(__dirname, "..", "references");
const LOG_FILE = path.join(LOG_DIR, "ac1-inconclusive-token.log");

const WALL_CLOCK_LIMIT_MS = 120000; // 120s
const TOKEN_LIMIT = 300000;

let pass = 0;
let fail = 0;
let inconclusive = false;

function log(msg) {
  console.log(`  ${msg}`);
}

function failTest(msg) {
  fail++;
  console.error(`  [FAIL] ${msg}`);
}

function passTest(msg) {
  pass++;
  console.log(`  [PASS] ${msg}`);
}

// Ensure log dir exists
fs.mkdirSync(LOG_DIR, { recursive: true });

// ── (a) Wall-clock test ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac1-"));
const diffFile = path.join(tmpDir, "diff.md");
const outputFile = path.join(tmpDir, "verdict.json");

// Copy golden diff
fs.copyFileSync(GOLDEN_DIFF, diffFile);

const startMs = performance.now();
let verdict;
try {
  verdict = runReview({ diffFile, round: 1, outputFile });
} catch (e) {
  failTest(`runReview threw: ${e.message}`);
}
const elapsedMs = performance.now() - startMs;

console.log(`  Wall-clock elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);

if (elapsedMs <= WALL_CLOCK_LIMIT_MS) {
  passTest(`wall-clock ${(elapsedMs / 1000).toFixed(1)}s ≤ ${WALL_CLOCK_LIMIT_MS / 1000}s`);
} else {
  failTest(`wall-clock ${(elapsedMs / 1000).toFixed(1)}s > ${WALL_CLOCK_LIMIT_MS / 1000}s`);
}

// ── (b) Token tri-state ──
if (!verdict) {
  inconclusive = true;
  log("AC-1 token: inconclusive-token (verdict not produced)");
  const entry = {
    timestamp: new Date().toISOString(),
    reason: "verdict not produced by runReview",
    elapsedMs: Math.round(elapsedMs),
  };
  fs.writeFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
} else {
  const parsedVerdict = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  const tokenUsage = parsedVerdict.reviewSnapshot?.tokenUsage ||
    (Array.isArray(parsedVerdict.reviewSnapshot)
      ? parsedVerdict.reviewSnapshot[0]?.tokenUsage
      : null);

  const total = tokenUsage?.total;

  if (total === null || total === undefined) {
    inconclusive = true;
    log("AC-1 token: inconclusive-token (token count absent)");
    const entry = {
      timestamp: new Date().toISOString(),
      reason: "token count absent from provider response",
      elapsedMs: Math.round(elapsedMs),
    };
    fs.writeFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } else if (total <= TOKEN_LIMIT) {
    passTest(`token count ${total} ≤ ${TOKEN_LIMIT}`);
  } else {
    failTest(`token count ${total} > ${TOKEN_LIMIT}`);
  }
}

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

// ── Results ──
console.log(`\n${pass} passed, ${fail} failed${inconclusive ? ", token INCONCLUSIVE" : ""}`);

if (inconclusive) {
  console.log("AC-1 token count unknown — mark inconclusive, human review required");
  process.exit(1);
}

process.exit(fail > 0 ? 1 : 0);
