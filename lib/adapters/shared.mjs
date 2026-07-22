import fs from "node:fs";
import path from "node:path";
import { fail } from "../errors.mjs";
import { providerRuntimeKey } from "../provider-ids.mjs";

const baseEnv = ["PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "NO_COLOR"];

export function environment(provider, source = process.env, extra = {}) {
  const selected = {};
  for (const name of new Set([...baseEnv, ...provider.auth.env, ...provider.env])) if (typeof source[name] === "string") selected[name] = source[name];
  return { ...selected, ...extra, THIRD_REVIEW_ACTIVE: "1" };
}

export function plan(provider, cwd, argv, input, extraEnv = {}) {
  return { command: provider.command, argv, cwd, input, env: environment(provider, process.env, extraEnv), redact: [...provider.auth.env, ...provider.env].map((name) => process.env[name]).filter((value) => typeof value === "string" && value.length > 0) };
}

export function lines(value) { return value.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
export function nonempty(value) { return typeof value === "string" && value.trim() ? value : null; }
export function invalid(message) { return { ok: false, error: { code: "PROVIDER_OUTPUT_INVALID", message } }; }
const livenessOnlyTypes = new Set(["heartbeat", "keepalive", "keep_alive", "ping", "pong", "liveness"]);
export function jsonProgress(stream, line) {
  if (stream !== "stdout") return { progress: false };
  try {
    const value = JSON.parse(line); const type = typeof value?.type === "string" ? value.type.toLowerCase() : null; const status = typeof value?.status === "string" ? value.status.toLowerCase() : null;
    if (livenessOnlyTypes.has(type) || (type === "status" && ["pending", "running"].includes(status))) return { liveness: true, progress: false, event: type };
    return { liveness: true, progress: true, event: type ?? "json" };
  }
  catch { return { progress: false }; }
}

export function restrictedFiles(runtime, provider) {
  const root = path.join(runtime, provider.runtime_key ?? providerRuntimeKey(provider.id) ?? provider.id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return root;
}

export function writeFile(file, contents) {
  try { fs.writeFileSync(file, contents, { mode: 0o600, flag: "w" }); return file; }
  catch (error) { fail("RUNTIME_UNAVAILABLE", `cannot create provider profile: ${error.message}`); }
}
