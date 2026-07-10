#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
const complete = input.includes("LARGE-MATERIAL-MARKER") && input.includes("END-MATERIAL-MARKER");
const review = complete
  ? { verdict: "pass", findings: [], resolutionSummary: "complete package received" }
  : { verdict: "escalate_to_human", findings: [], resolutionSummary: "package incomplete" };
process.stdout.write(JSON.stringify({ type: "result", structured_output: review }));
