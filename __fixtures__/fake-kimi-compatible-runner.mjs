#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("kimi, version 1.48.0"); process.exit(0); }
if (args.includes("--help")) { console.log("--print --input-format --output-format --final-message-only"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let request;
  try { request = JSON.parse(input.trim()); } catch { process.exit(2); }
  if (request.role !== "user" || typeof request.content !== "string") process.exit(3);
  console.log(JSON.stringify({ type: "assistant", role: "assistant", content: JSON.stringify({
    verdict: "pass", findings: [], resolutionSummary: "reviewed by fake kimi",
  }) }));
});
