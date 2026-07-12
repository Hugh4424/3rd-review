import { invalid, lines, nonempty, plan } from "./shared.mjs";

function parse(stdout) {
  let session = null; let text = null; let usage = null; let done = false;
  for (const item of lines(stdout)) { if (item.type === "thread.started") session ??= nonempty(item.thread_id); if (item.type === "item.completed" && item.item?.type === "agent_message") text = nonempty(item.item.text ?? item.item.content) ?? text; usage ??= item.usage ?? null; done ||= ["turn.completed", "thread.completed"].includes(item.type); }
  return text && done ? { ok: true, text, session_id: session, usage } : invalid("Codex emitted no completed final message");
}

export default {
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  start(provider, cwd, prompt) { const argv = ["exec", "-C", cwd, "-s", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]; if (provider.model) argv.push("-m", provider.model); if (provider.effort) argv.push("-c", `model_reasoning_effort=${JSON.stringify(provider.effort)}`); argv.push("--json", "-"); return plan(provider, cwd, argv, prompt); },
  resume(provider, cwd, session, prompt) { const argv = ["exec", "resume", session, "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]; if (provider.model) argv.push("-m", provider.model); if (provider.effort) argv.push("-c", `model_reasoning_effort=${JSON.stringify(provider.effort)}`); argv.push("--json", "-"); return plan(provider, cwd, argv, prompt); },
  parse,
};
