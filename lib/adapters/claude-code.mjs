import { invalid, jsonProgress, nonempty, plan } from "./shared.mjs";

function parse(stdout) {
  try {
    const value = JSON.parse(stdout); const text = nonempty(value.result);
    return text ? { ok: true, text, session_id: nonempty(value.session_id), usage: value.usage ?? value.modelUsage ?? null } : invalid("Claude Code returned no final text");
  } catch { return invalid("Claude Code did not return JSON output"); }
}

export default {
  capabilities: { continuation: true, attachment_delivery: ["always_embed"] },
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  start(provider, cwd, prompt) {
    const argv = ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--safe-mode", "--disable-slash-commands", "--allowedTools", "Read", "--disallowedTools", "Agent,Bash,Edit,Write,NotebookEdit,Task,WebFetch,WebSearch"];
    if (provider.model) argv.push("--model", provider.model); if (provider.effort) argv.push("--effort", provider.effort);
    return { ...plan(provider, cwd, argv, prompt), observeLine: jsonProgress };
  },
  resume(provider, cwd, session, prompt) {
    const next = this.start(provider, cwd, prompt); next.argv.splice(0, 0, "--resume", session); return next;
  }, parse,
};
