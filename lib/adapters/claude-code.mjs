import { invalid, jsonProgress, lines, nonempty, plan } from "./shared.mjs";

function parse(stdout) {
  let result = null; let session = null;
  for (const value of lines(stdout)) {
    session ??= nonempty(value.session_id);
    if (value.type === "result") result = value;
  }
  if (!result) return invalid("Claude Code emitted no terminal result event");
  if (result.is_error === true || result.subtype !== "success") return invalid("Claude Code returned a terminal error");
  const text = nonempty(result.result);
  return text ? { ok: true, text, session_id: nonempty(result.session_id) ?? session, usage: result.usage ?? result.modelUsage ?? null } : invalid("Claude Code returned no final text");
}

function observeLine(stream, line) {
  const observed = jsonProgress(stream, line); if (stream !== "stdout") return observed;
  try {
    const value = JSON.parse(line); const session_id = nonempty(value.session_id);
    if (value.type === "result") return { ...observed, session_id, terminal: value.is_error === true || value.subtype !== "success" ? { state: "failed", session_id, error: { code: "PROVIDER_OUTPUT_INVALID", message: "Claude Code returned a terminal error" } } : { state: "completed", session_id } };
    return { ...observed, session_id };
  } catch { return observed; }
}

export default {
  capabilities: { continuation: true, attachment_delivery: ["always_embed"] },
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  start(provider, cwd, prompt) {
    const argv = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--permission-mode", "dontAsk", "--safe-mode", "--disable-slash-commands", "--allowedTools", "Read", "--disallowedTools", "Agent,Bash,Edit,Write,NotebookEdit,Task,WebFetch,WebSearch"];
    if (provider.model) argv.push("--model", provider.model); if (provider.effort) argv.push("--effort", provider.effort);
    return { ...plan(provider, cwd, argv, prompt), observeLine };
  },
  resume(provider, cwd, session, prompt) {
    const next = this.start(provider, cwd, prompt); next.argv.splice(0, 0, "--resume", session); return next;
  }, parse, observeLine,
};
