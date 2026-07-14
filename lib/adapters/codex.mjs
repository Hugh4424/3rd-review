import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalid, jsonProgress, lines, nonempty, plan } from "./shared.mjs";

const client = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-app-server-client.mjs");

function parse(stdout) {
  let session = null; let text = null; let usage = null; let done = false;
  for (const item of lines(stdout)) { if (item.type === "thread.started") session ??= nonempty(item.thread_id); if (item.type === "item.completed" && item.item?.type === "agent_message") text = nonempty(item.item.text ?? item.item.content) ?? text; usage ??= item.usage ?? null; done ||= ["turn.completed", "thread.completed"].includes(item.type); }
  return text && done ? { ok: true, text, session_id: session, usage } : invalid("Codex emitted no completed final message");
}

export default {
  capabilities: { continuation: true, attachment_delivery: ["always_embed"] },
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  start(provider, cwd, prompt) { return this.resume(provider, cwd, null, prompt); },
  resume(provider, cwd, session, prompt) {
    const input = JSON.stringify({ command: provider.command, cwd, prompt, session, model: provider.model, effort: provider.effort });
    return { ...plan({ ...provider, command: process.execPath }, cwd, [client], input), observeLine: jsonProgress };
  },
  parse,
};
