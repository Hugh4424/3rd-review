import { createHash, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalid, lines, nonempty, plan } from "./shared.mjs";

function parse(stdout) { let session = null; let text = null; let usage = null; let done = false; for (const item of lines(stdout)) { session ??= nonempty(item.sessionID ?? item.session_id ?? item.session?.id); usage ??= item.usage ?? item.part?.tokens ?? null; text = nonempty(item.text ?? item.part?.text ?? item.message?.text ?? item.message?.content) ?? text; done ||= ["step_finish", "session.completed", "runner.completed"].includes(item.type); } return text && done ? { ok: true, text, session_id: session, usage } : invalid("OpenCode emitted no completed final message"); }
const reviewInstruction = "Review only the supplied instruction and the frozen files in the current directory. Do not access parent directories, use git, shell, network, host paths, or any files outside the current directory. Do not use write or edit tools and do not create an output file. Return exactly the requested JSON object directly as the final assistant response: no preface, explanation, or Markdown code fence before or after the JSON.";
const controller = fileURLToPath(new URL("./opencode-supervised-cli.mjs", import.meta.url));

function cursorFor(messages, status = null) {
  if (!messages.length && !status) return null;
  return createHash("sha256").update(JSON.stringify({ messages, status })).digest("hex");
}
function assistantTerminal(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]; if (message?.info?.role !== "assistant") continue;
    const finishPart = message.parts?.findLast?.((part) => part?.type === "step-finish");
    const finished = message.info?.time?.completed || message.info?.finish || finishPart;
    if (!finished) return null;
    const reason = message.info?.finish ?? finishPart?.reason;
    if (["error", "failed", "cancelled", "canceled"].includes(String(reason).toLowerCase()) || message.info?.error) return { failed: true, message: message.info?.error?.message ?? `OpenCode session finished with ${reason ?? "an error"}` };
    const text = message.parts?.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("").trim();
    if (!text) return { failed: true, message: "OpenCode terminal session has no assistant text" };
    return { text, usage: message.info?.tokens ?? null };
  }
  return null;
}
async function json(url, signal, fetchImpl) {
  const response = await fetchImpl(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenCode health API returned HTTP ${response.status}`);
  return response.json();
}

export function createOpenCodeProbe({ url, fetchImpl = fetch } = {}) {
  return async ({ session_id, cursor = null, signal } = {}) => {
    if (!session_id) return { status: "unverifiable", session_id: null, cursor, raw: null, error: { code: "SESSION_UNKNOWN" }, evidence: "OpenCode has not emitted a session id" };
    if (signal?.aborted) return { status: "unverifiable", session_id, cursor, raw: null, error: { code: "PROBE_ABORTED" }, evidence: "OpenCode probe aborted" };
    try {
      const [statuses, messages] = await Promise.all([
        json(`${url}/session/status`, signal, fetchImpl),
        json(`${url}/session/${encodeURIComponent(session_id)}/message`, signal, fetchImpl),
      ]);
      if (!Array.isArray(messages) || messages.some((message) => message?.info?.sessionID !== session_id)) throw new Error("OpenCode returned messages for an unexpected session");
      const status = statuses?.[session_id]?.type;
      const nextCursor = cursorFor(messages, statuses?.[session_id] ?? null); const terminal = assistantTerminal(messages);
      if (status === "busy") return { status: "busy", session_id, cursor: nextCursor, raw: null, error: null, evidence: "OpenCode session status is busy" };
      if (status === "retry") return { status: "retry", session_id, cursor: nextCursor, raw: null, error: null, evidence: "OpenCode session status is retry" };
      if (terminal?.failed) return { status: "failed", session_id, cursor: nextCursor, raw: null, error: { code: "PROVIDER_HEALTH_FAILED", message: terminal.message }, evidence: "OpenCode terminal failure" };
      if (terminal) {
        const stdout = `${JSON.stringify({ type: "session.completed", session_id, text: terminal.text, usage: terminal.usage })}\n`;
        return { status: "completed", session_id, cursor: nextCursor, raw: { stdout, stderr: "" }, error: null, evidence: "OpenCode assistant terminal message" };
      }
      if (nextCursor && nextCursor !== cursor) return { status: "progressing", session_id, cursor: nextCursor, raw: null, error: null, evidence: "OpenCode message or part changed" };
      return { status: "unverifiable", session_id, cursor: nextCursor, raw: null, error: { code: "SESSION_IDLE_WITHOUT_TERMINAL" }, evidence: "OpenCode session is not busy and has no terminal assistant message" };
    } catch (error) {
      return { status: "unverifiable", session_id, cursor, raw: null, error: { code: signal?.aborted ? "PROBE_ABORTED" : "PROBE_FAILED", message: error.message }, evidence: signal?.aborted ? "OpenCode probe aborted" : "OpenCode health API unavailable" };
    }
  };
}

function observeLine(stream, line) {
  if (stream !== "stdout") return { progress: false };
  try { const value = JSON.parse(line); const session_id = nonempty(value.sessionID ?? value.session_id ?? value.session?.id); const cursor = nonempty(value.part?.id ?? value.message?.id ?? value.id); return { liveness: true, progress: true, event: value.type ?? "json", session_id, cursor }; }
  catch { return { progress: false }; }
}
function executionPlan(provider, cwd, prompt, session = null) {
  cwd = fs.realpathSync(cwd);
  if (!/^opencode(?:$|[-_.])/.test(path.basename(provider.command))) {
    const argv = ["run", ...(session ? ["--session", session] : []), "--pure", "--dir", cwd, "--format", "json"];
    if (provider.model) argv.push("--model", provider.model); if (provider.effort) argv.push("--variant", provider.effort);
    return { ...plan(provider, cwd, argv, prompt, { OPENCODE_DISABLE_CLAUDE_CODE: "1" }), observeLine };
  }
  const port = randomInt(49152, 65536); const url = `http://127.0.0.1:${port}`;
  const clientArgv = ["run", "--attach", url, "--pure", "--dir", cwd, "--format", "json"];
  if (session) clientArgv.push("--session", session);
  if (provider.model) clientArgv.push("--model", provider.model);
  if (provider.effort) clientArgv.push("--variant", provider.effort);
  const specification = Buffer.from(JSON.stringify({ command: provider.command, url, port, clientArgv, session }), "utf8").toString("base64url");
  const result = plan(provider, cwd, [specification], prompt, { OPENCODE_DISABLE_CLAUDE_CODE: "1" });
  return { ...result, command: controller, clientArgv, healthServer: { url, bind: { hostname: "127.0.0.1", port } }, observeLine, probeSession: createOpenCodeProbe({ url }) };
}

export default {
  capabilities: { continuation: true, attachment_delivery: ["file_only", "always_embed"] },
  modelInstruction: reviewInstruction,
  requiresWritableCwd: true,
  stableContinuationCwd: true,
  promptViaStdin: true,
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  start(provider, cwd, prompt) { return executionPlan(provider, cwd, prompt); },
  resume(provider, cwd, session, prompt) { return executionPlan(provider, cwd, prompt, session); },
  parse,
};
