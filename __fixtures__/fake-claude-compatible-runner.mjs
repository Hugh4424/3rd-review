#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("2.1.206\n"); process.exit(0); }
if (process.argv.includes("--help")) { process.stdout.write("--print --output-format --json-schema --safe-mode --tools --permission-mode --no-session-persistence\n"); process.exit(0); }
for await (const _chunk of process.stdin) {}
process.stdout.write(JSON.stringify({ structured_output: { verdict: "pass", findings: [], resolutionSummary: "compatible" } }));
