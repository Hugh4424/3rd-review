#!/usr/bin/env node
import process from "node:process";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("pi 0.81.1"); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const sessionFlag = args.includes("--session") ? "--session" : "--session-id";
  const session = process.env.PI_FAKE_SESSION_ID ?? args[args.indexOf(sessionFlag) + 1] ?? "pi-fake-session";
  const stopReason = process.env.PI_FAKE_STOP_REASON ?? "stop";
  const willRetry = process.env.PI_FAKE_WILL_RETRY === "1";
  const settled = process.env.PI_FAKE_NO_SETTLED !== "1";
  console.log(JSON.stringify({ type: "session", version: 3, id: session }));
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", partial: { content: [{ type: "thinking", thinking: "x".repeat(process.env.PI_FAKE_OVERSIZED_UPDATE === "1" ? 1024 * 1024 + 1 : 8192) }] } } }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: `PI_FINAL:${prompt}` }], model: "deepseek-v4-flash", usage: { totalTokens: 7 }, stopReason } }));
  console.log(JSON.stringify(process.env.PI_FAKE_MISSING_WILL_RETRY === "1" ? { type: "agent_end" } : { type: "agent_end", willRetry }));
  if (settled) console.log(JSON.stringify({ type: "agent_settled" }));
});
