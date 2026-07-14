import fs from "node:fs";
import path from "node:path";
import { invalid, jsonProgress, lines, nonempty, plan } from "./shared.mjs";

function assistantText(value) {
  if (typeof value === "string") return nonempty(value);
  if (!Array.isArray(value)) return null;
  const blocks = value.filter((block) => block && block.type === "text").map((block) => nonempty(block.text)).filter(Boolean);
  return blocks.length ? blocks.join("\n") : null;
}

const initializeId = "initialize";
const promptId = "prompt";

function wireText(item) {
  if (item?.method !== "event") return null;
  const params = item.params;
  if (params?.type === "TextPart" || (params?.type === "ContentPart" && params.payload?.type === "text")) return typeof params.payload?.text === "string" ? params.payload.text : null;
  return null;
}

function wireStatus(item) {
  if (item?.id !== promptId) return null;
  if (item.error) return { kind: "failed", code: "PROVIDER_WIRE_FAILED", message: item.error.message ?? "Kimi Wire prompt failed" };
  const status = item.result?.status;
  if (status === "finished") return { kind: "finished" };
  if (status === "cancelled") return { kind: "failed", code: "CANCELLED", message: "Kimi Wire prompt was cancelled" };
  if (status === "max_steps_reached") return { kind: "failed", code: "PROVIDER_MAX_STEPS", message: "Kimi Wire reached its maximum steps" };
  return { kind: "unverifiable", code: "PROVIDER_WIRE_INVALID", message: "Kimi Wire returned an unknown prompt status" };
}

function wirePlan(provider, cwd, prompt, session = null) {
  const state = { stdout: [], stderr: [], cursor: 0, reported: 0, retryCursor: null, text: [], session, terminal: null, promptResponseSeen: false, protocolError: null };
  const bundle = path.join(cwd, "bundle"); const attachmentRoot = fs.existsSync(bundle) ? bundle : cwd;
  const argv = ["--wire", "--work-dir", cwd, "--skills-dir", path.join(attachmentRoot, "skills"), "--afk"];
  if (provider.model) argv.push("--model", provider.model);
  if (provider.thinking === true) argv.push("--thinking");
  if (provider.thinking === false) argv.push("--no-thinking");
  if (session) argv.push("--session", session);
  const input = [
    { jsonrpc: "2.0", id: initializeId, method: "initialize", params: { protocol_version: "1.10", client: { name: "3rd-review", version: "4.0.0" } } },
    { jsonrpc: "2.0", id: promptId, method: "prompt", params: { user_input: prompt } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
  const observeLine = (stream, line) => {
    state[stream].push(line); state.cursor += 1;
    if (stream === "stderr") {
      state.session ??= line.match(/^To resume this session:\s*kimi\s+-r\s+([0-9a-f]{8}-[0-9a-f-]{27,})\s*$/i)?.[1] ?? null;
      return { progress: false, retry_count: (line.match(/APIEmptyResponseError/g) ?? []).length };
    }
    let item; try { item = JSON.parse(line); } catch { return { progress: false }; }
    const text = wireText(item); if (text) state.text.push(text);
    if (item.method === "event" && item.params?.type === "StepRetry") state.retryCursor = state.cursor;
    const isPromptResponse = item.id === promptId && (Object.hasOwn(item, "result") || Object.hasOwn(item, "error"));
    const duplicateResponse = isPromptResponse && state.promptResponseSeen;
    if (duplicateResponse) state.protocolError = "Kimi Wire emitted a second response for the prompt id";
    if (isPromptResponse) state.promptResponseSeen = true;
    const terminal = duplicateResponse ? null : wireStatus(item); if (terminal) state.terminal = terminal;
    if (item.id === initializeId && item.error && item.error.code !== -32601) state.protocolError = item.error.message ?? "Kimi Wire initialize failed";
    const type = item.method === "event" ? item.params?.type : item.id === promptId ? "prompt.response" : "wire.response";
    const terminalObservation = terminal?.kind === "finished"
      ? { terminal: { state: "completed", session_id: state.session, cursor: state.cursor, wait_for_close: true } }
      : terminal?.kind === "failed" ? { terminal: { state: "failed", session_id: state.session, cursor: state.cursor, wait_for_close: true, error: { code: terminal.code, message: terminal.message } } }
        : terminal?.kind === "unverifiable" ? { terminal: { state: "failed", session_id: state.session, cursor: state.cursor, wait_for_close: true, error: { code: terminal.code, message: terminal.message } } } : {};
    return { liveness: true, progress: item.method === "event", progress_key: `kimi-wire:${state.cursor}`, cursor: state.cursor, session_id: state.session, event: type, ...terminalObservation };
  };
  const probeSession = async ({ signal } = {}) => {
    if (signal?.aborted) { const error = new Error("Kimi Wire probe aborted"); error.name = "AbortError"; throw error; }
    const raw = { stdout: state.stdout.length ? `${state.stdout.join("\n")}\n` : "", stderr: state.stderr.length ? `${state.stderr.join("\n")}\n` : "" };
    const common = { session_id: state.session, cursor: state.cursor, raw: null, error: null, evidence: "Kimi Wire channel" };
    if (state.protocolError) return { ...common, status: "unverifiable", error: { code: "PROVIDER_WIRE_INVALID", message: state.protocolError } };
    if (state.terminal?.kind === "failed") return { ...common, status: "failed", error: { code: state.terminal.code, message: state.terminal.message } };
    if (state.terminal?.kind === "unverifiable") return { ...common, status: "unverifiable", error: { code: state.terminal.code, message: state.terminal.message } };
    if (state.terminal?.kind === "finished" && state.text.length && state.session) return { ...common, status: "completed", raw };
    if (state.retryCursor === state.cursor && state.cursor > state.reported) { state.reported = state.cursor; return { ...common, status: "retry" }; }
    if (state.cursor > state.reported) { state.reported = state.cursor; return { ...common, status: "progressing" }; }
    return { ...common, status: "busy" };
  };
  return { ...plan(provider, cwd, argv, input), keepStdinOpen: true, observeLine, probeSession };
}

function parse(stdout, stderr = "") {
  const combined = `${stdout}\n${stderr}`;
  // Kimi writes this exact final hint to stderr. Do not search arbitrary model
  // text: a reviewer can legitimately quote `kimi -r example` in its answer.
  let session = combined.match(/^To resume this session:\s*kimi\s+-r\s+([0-9a-f]{8}-[0-9a-f-]{27,})\s*$/mi)?.[1] ?? null; let text = null; let usage = null; let terminal = false; let wireTranscript = false; let promptResponseSeen = false; let protocolInvalid = false; const wireTexts = [];
  for (const item of lines(stdout)) {
    if (item?.jsonrpc === "2.0" || item?.method === "event" || item?.id === promptId) wireTranscript = true;
    if (item?.id === promptId && (Object.hasOwn(item, "result") || Object.hasOwn(item, "error"))) { if (promptResponseSeen) protocolInvalid = true; promptResponseSeen = true; }
    session ??= nonempty(item.session_id ?? item.sessionId); usage ??= item.usage ?? null;
    const wire = wireText(item); if (wire) wireTexts.push(wire);
    const response = wireStatus(item); if (response?.kind === "finished") terminal = true;
    if (["final", "result", "message.completed"].includes(item.type)) terminal = true;
    if (["final", "result", "message.completed"].includes(item.type) || item.role === "assistant") text = nonempty(item.text ?? item.result) ?? assistantText(item.content ?? item.message?.content) ?? text;
  }
  if (wireTexts.length) text = wireTexts.join("");
  // The CLI's explicit resume hint is terminal evidence; arbitrary reviewer
  // text is not enough to fabricate a resumable session.
  return !protocolInvalid && text && (wireTranscript ? terminal : terminal || session !== null) ? { ok: true, text, session_id: session, usage } : invalid("Kimi emitted no terminal final message");
}

function observeLine(stream, line) {
  const retry_count = (line.match(/APIEmptyResponseError/g) ?? []).length;
  return { ...jsonProgress(stream, line), retry_count };
}

const reviewInstruction = "Review only the supplied instruction and the frozen files under bundle/ in the current isolated attachment workspace. Do not use git, shell, network, host paths, or any files outside this workspace. Return only the requested review.";

export default {
  capabilities: { continuation: true, attachment_delivery: ["file_only"] },
  modelInstruction: reviewInstruction,
  requiresWritableCwd: true,
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  // Kimi requires a writable work-dir. The broker keeps bundle/ frozen and
  // passes its skills directory separately.
  start(provider, cwd, prompt) { return wirePlan(provider, cwd, prompt); },
  resume(provider, cwd, session, prompt) { return wirePlan(provider, cwd, prompt, session); }, parse,
};
