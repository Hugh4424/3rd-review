import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalid, nonempty, plan, restrictedFiles } from "./shared.mjs";

const controller = fileURLToPath(new URL("./pi-supervised-cli.mjs", import.meta.url));
const reviewInstruction = "Review only the supplied instruction and the frozen files under bundle/ in the current isolated attachment workspace. Do not access parent directories, use git, shell, network, host paths, or any files outside this workspace. Do not use write or edit tools. Return only the requested review.";

function text(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function thinking(provider) {
  if (provider.effort) return provider.effort;
  if (provider.thinking === true) return "low";
  if (provider.thinking === false) return "off";
  return null;
}

function parse(stdout, _stderr = "", expectedSession = null) {
  let session = null; let final = null; let phase = "session"; let malformed = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item; try { item = JSON.parse(line); } catch { malformed = true; continue; }
    if (item.type === "pi.session") {
      const value = nonempty(item.id); if (!value || session || phase !== "session") { malformed = true; continue; }
      session = value; phase = "turn";
    } else if (item.type === "pi.progress") {
      if (phase !== "turn") malformed = true;
    } else if (item.type === "pi.final") {
      if (phase !== "turn") malformed = true; else final = item;
    } else if (item.type === "pi.agent_end") {
      if (phase !== "turn" || typeof item.will_retry !== "boolean") malformed = true;
      else if (item.will_retry === false) phase = "ending";
    } else if (item.type === "pi.agent_settled") {
      if (phase !== "ending") malformed = true; else phase = "settled";
    } else malformed = true;
  }
  if (malformed) return invalid("Pi supervised stream is malformed");
  if (!session) return invalid("Pi emitted no session header");
  if (expectedSession && session !== expectedSession) return invalid("Pi emitted an unexpected session id");
  if (!final || final.stop_reason !== "stop") return invalid("Pi emitted no successful final assistant message");
  if (phase !== "settled") return invalid("Pi did not settle its agent turn");
  const result = text(final.text);
  return result ? { ok: true, text: result, session_id: session, usage: final.usage ?? null } : invalid("Pi emitted no final assistant text");
}

function observeLine(stream, line) {
  if (stream !== "stdout") return { progress: false };
  try {
    const item = JSON.parse(line);
    if (item.type === "pi.session") return { liveness: true, progress: false, event: item.type, session_id: nonempty(item.id) };
    if (item.type === "pi.progress") return { liveness: true, progress: true, event: item.event ?? item.type };
    if (["pi.final", "pi.agent_end", "pi.agent_settled"].includes(item.type)) return { liveness: true, progress: true, event: item.type };
    return { progress: false };
  } catch { return { progress: false }; }
}

function executionPlan(provider, cwd, prompt, runtime, session = null) {
  const root = restrictedFiles(runtime, provider); const sessions = path.join(root, "sessions"); fs.mkdirSync(sessions, { recursive: true, mode: 0o700 }); fs.chmodSync(sessions, 0o700);
  const expectedSession = session ?? randomUUID();
  const clientArgv = ["--mode", "json", "--print"];
  if (provider.model) clientArgv.push("--model", provider.model);
  const level = thinking(provider); if (level) clientArgv.push("--thinking", level);
  clientArgv.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--tools", "read,grep,find,ls", "--session-dir", sessions);
  clientArgv.push(session ? "--session" : "--session-id", expectedSession);
  const specification = Buffer.from(JSON.stringify({ command: provider.command, argv: clientArgv, cwd }), "utf8").toString("base64url");
  return { ...plan({ ...provider, command: process.execPath }, cwd, [controller, specification], prompt), clientArgv, expectedSession, observeLine };
}

export default {
  capabilities: { continuation: true, attachment_delivery: ["file_only", "always_embed"] },
  modelInstruction: reviewInstruction,
  requiresWritableCwd: true,
  stableContinuationCwd: true,
  runFromWritableRoot: true,
  promptViaStdin: true,
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  start: (provider, cwd, prompt, runtime) => executionPlan(provider, cwd, prompt, runtime),
  resume: (provider, cwd, session, prompt, runtime) => executionPlan(provider, cwd, prompt, runtime, session),
  parse,
  observeLine,
};
