#!/usr/bin/env node
let input = ""; for await (const chunk of process.stdin) input += chunk;
const output = input.includes("FORMAT REPAIR")
  ? { verdict: "pass", findings: [], resolutionSummary: "repaired" }
  : { verdict: "approved", findings: [], resolutionSummary: "invalid" };
process.stdout.write(JSON.stringify({ structured_output: output }));
