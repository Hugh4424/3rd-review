#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("slow-success 1.0"); process.exit(0); }
setTimeout(() => {
  console.log(JSON.stringify({ type: "final", session_id: "kimi-session", text: "slow opinion" }));
}, 150);
