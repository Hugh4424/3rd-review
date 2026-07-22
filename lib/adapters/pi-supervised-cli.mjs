#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const MAX_RAW_EVENT_BYTES = 1024 * 1024;
const specification = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
const prompt = await new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
});

let child = null;
let stopping = false;
let protocolInvalid = false;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const textBlocks = (content) => Array.isArray(content) ? content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("") : "";
function rejectProtocol(message) {
  if (protocolInvalid) return;
  protocolInvalid = true;
  process.stderr.write(`${message}\n`);
  if (child && !child.killed) child.kill("SIGTERM");
}

function forward(value) {
  if (!value || typeof value !== "object" || typeof value.type !== "string") return rejectProtocol("Pi emitted an invalid JSON event");
  if (value.type === "session") { emit({ type: "pi.session", id: value.id, version: value.version ?? null }); return; }
  if (value.type === "message_update") { emit({ type: "pi.progress", event: value.assistantMessageEvent?.type ?? "message_update" }); return; }
  if (value.type === "message_end" && value.message?.role === "assistant") {
    emit({ type: "pi.final", text: textBlocks(value.message.content), model: value.message.model ?? null, usage: value.message.usage ?? null, stop_reason: value.message.stopReason ?? null });
    return;
  }
  if (value.type === "agent_end") {
    if (typeof value.willRetry !== "boolean") return rejectProtocol("Pi emitted agent_end without boolean willRetry");
    emit({ type: "pi.agent_end", will_retry: value.willRetry });
    return;
  }
  if (value.type === "agent_settled") { emit({ type: "pi.agent_settled" }); return; }
  if (["turn_start", "turn_end", "tool_execution_start", "tool_execution_end", "message_start"].includes(value.type)) emit({ type: "pi.progress", event: value.type });
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { stopping = true; child?.kill(signal); });

try {
  child = spawn(specification.command, specification.argv, { cwd: specification.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.pipe(process.stderr);
  child.stdin.once("error", (error) => { if (error.code !== "EPIPE") process.stderr.write(`Pi stdin failed: ${error.message}\n`); });
  child.stdin.end(prompt);
  let pending = "";
  const consume = (line) => {
    if (Buffer.byteLength(line, "utf8") > MAX_RAW_EVENT_BYTES) return rejectProtocol(`Pi emitted an event larger than ${MAX_RAW_EVENT_BYTES} bytes`);
    try { forward(JSON.parse(line)); }
    catch { rejectProtocol("Pi emitted malformed JSONL"); }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (protocolInvalid) return;
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      consume(line);
      if (protocolInvalid) { pending = ""; return; }
    }
    if (Buffer.byteLength(pending, "utf8") > MAX_RAW_EVENT_BYTES) rejectProtocol(`Pi emitted an event larger than ${MAX_RAW_EVENT_BYTES} bytes`);
  });
  child.stdout.once("end", () => {
    if (!protocolInvalid && pending) consume(pending.replace(/\r$/, ""));
  });
  const code = await new Promise((resolve) => {
    child.once("error", (error) => { process.stderr.write(`${error.message}\n`); resolve(1); });
    child.once("close", (value) => resolve(value ?? 1));
  });
  process.exitCode = stopping || protocolInvalid ? 1 : code;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
