#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("fake-cli 1.0"); process.exit(0); }
if (args.includes("-p")) console.log(JSON.stringify({ result: "claude opinion", session_id: "claude-session" }));
else if (args.includes("exec")) console.log(`${JSON.stringify({ type: "thread.started", thread_id: "codex-session" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex opinion" } })}\n${JSON.stringify({ type: "turn.completed" })}`);
else if (args.includes("--output-format")) console.log(JSON.stringify({ type: "final", session_id: "kimi-session", text: "kimi opinion" }));
else if (args.includes("run")) console.log(JSON.stringify({ type: "session.completed", session_id: "opencode-session", text: "opencode opinion" }));
else { console.error("unknown fake invocation"); process.exit(1); }
