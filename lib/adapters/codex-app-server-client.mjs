#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const server = spawn(input.command, ["app-server", "--stdio"], { cwd: input.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let threadId = null; let turnId = null; let terminal = false; let failed = false;

const finish = () => { if (terminal) return; terminal = true; if (!server.killed) server.kill("SIGTERM"); };
const fail = (message) => { failed = true; emit({ type: "error", message }); finish(); };
const startTurn = () => send({ method: "turn/start", id: 2, params: { threadId, input: [{ type: "text", text: input.prompt }], cwd: input.cwd, approvalPolicy: "never", ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) } });

readline.createInterface({ input: server.stdout }).on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { fail("Codex app-server emitted invalid JSON"); return; }
  if (message.error) { fail(message.error.message ?? "Codex app-server request failed"); return; }
  if (message.id === 0) {
    send({ method: "initialized", params: {} });
    send(input.session ? { method: "thread/resume", id: 1, params: { threadId: input.session, cwd: input.cwd, approvalPolicy: "never", sandbox: "read-only", ...(input.model ? { model: input.model } : {}) } } : { method: "thread/start", id: 1, params: { cwd: input.cwd, approvalPolicy: "never", sandbox: "read-only", ...(input.model ? { model: input.model } : {}), serviceName: "3rd-review" } });
  } else if (message.id === 1) {
    threadId = message.result?.thread?.id ?? input.session; if (!threadId) { fail("Codex app-server returned no thread id"); return; }
    emit({ type: "thread.started", thread_id: threadId }); startTurn();
  } else if (message.id === 2) turnId = message.result?.turn?.id ?? turnId;
  else if (message.method === "turn/started") { turnId = message.params?.turn?.id ?? turnId; emit({ type: "turn.started", turn_id: turnId }); }
  else if (message.method === "item/completed") {
    const item = message.params?.item;
    if (item?.type === "agentMessage") emit({ type: "item.completed", item: { type: "agent_message", text: item.text ?? item.content } });
    else emit({ type: "item.completed", item });
  } else if (message.method === "turn/completed") {
    const status = message.params?.turn?.status;
    if (status === "completed") emit({ type: "turn.completed", usage: message.params?.turn?.usage ?? null });
    else emit({ type: "turn.failed", error: { message: `Codex turn ended with ${status ?? "unknown"}` } });
    finish();
  }
});
server.stderr.on("data", (chunk) => process.stderr.write(chunk));
server.once("error", (error) => fail(error.message));
server.once("close", (code) => process.exit(failed ? 1 : (terminal && code === 0 ? 0 : (code || (terminal ? 0 : 1)))));
send({ method: "initialize", id: 0, params: { clientInfo: { name: "3rd_review", title: "3rd-review", version: "4.0.0" } } });

const interrupt = () => {
  if (threadId && turnId && !server.killed) send({ method: "turn/interrupt", id: 99, params: { threadId, turnId } });
  finish();
};
process.once("SIGTERM", interrupt);
process.once("SIGINT", interrupt);
