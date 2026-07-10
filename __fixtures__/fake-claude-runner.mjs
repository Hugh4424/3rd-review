#!/usr/bin/env node
if (process.env.FAKE_CLAUDE_MODE === "fail") process.exit(1);
if (process.env.FAKE_CLAUDE_MODE === "null") {
  process.stdout.write(JSON.stringify({ type: "result", structured_output: null, result: "not json" }));
  process.exit(0);
}
const review = { verdict: "pass", findings: [], resolutionSummary: "reviewed" };
if (process.env.FAKE_CLAUDE_MODE === "result") {
  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(review) }));
} else {
  process.stdout.write(JSON.stringify({ type: "result", structured_output: review, result: "ignored" }));
}
