#!/usr/bin/env node
if (process.argv.includes("--version")) process.stdout.write("2.1.76\n");
else if (process.argv.includes("--help")) process.stdout.write("--print --output-format --json-schema --tools --permission-mode --no-session-persistence\n");
else process.exit(9);
