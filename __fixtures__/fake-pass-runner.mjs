#!/usr/bin/env node
// Fake review-runner for pass-evidence enforcement e2e testing.
// Writes a pass verdict JSON to --result-file.
// Controlled by OMIT_FIELD env var: none|reviewSnapshot|riskDisposition|worktreeInventory
// OMIT_FIELD=none emits valid pass verdict with all 3 required fields.
// Any other value omits that field from the verdict, exercising the enforcement path.

import { writeFileSync } from "node:fs";

function parseArgv(args) {
  const parsed = {};
  for (const a of args) {
    if (a.startsWith("--result-file=")) parsed.resultFile = a.slice("--result-file=".length);
    else if (a.startsWith("--prompt-file=")) parsed.promptFile = a.slice("--prompt-file=".length);
    else if (a.startsWith("--review-request-id=")) parsed.requestId = a.slice("--review-request-id=".length);
  }
  return parsed;
}

const args = parseArgv(process.argv.slice(2));
const omit = process.env.OMIT_FIELD || "none";

if (!args.resultFile) {
  process.stderr.write("fake-pass-runner: missing --result-file\n");
  process.exit(1);
}

const verdict = { verdict: "pass" };

if (omit !== "reviewSnapshot") {
  verdict.reviewSnapshot = [{ path: "a.ts", gitHead: "abc123", mtime: "2026-01-01T00:00:00Z", hash: "def456" }];
}
if (omit !== "riskDisposition") {
  verdict.riskDisposition = [];
}
if (omit !== "worktreeInventory") {
  verdict.worktreeInventory = { included: [], unrelated: [], excluded: [] };
}

writeFileSync(args.resultFile, JSON.stringify(verdict) + "\n");
process.exit(0);
