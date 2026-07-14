#!/usr/bin/env node
import readline from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId ?? "codex-thread" } } });
  }
  if (message.method === "turn/start") {
    if (message.params.input?.[0]?.text === "FAIL_PROTOCOL") { send({ id: message.id, error: { code: -32602, message: "bad turn" } }); return; }
    send({ id: message.id, result: { turn: { id: "codex-turn", status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "codex-turn", status: "inProgress", items: [] } } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: "codex-turn", item: { id: "item-1", type: "agentMessage", text: "CODEX_FINAL" } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "codex-turn", status: "completed", items: [] } } });
  }
  if (message.method === "turn/interrupt") process.exit(0);
});
