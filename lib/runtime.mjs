import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";

function file(root, id) { return path.join(root, id, "state.json"); }
function now() { return Date.now(); }
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
    return result.status === 0 && new RegExp(`\\b${pid}\\b`).test(result.stdout ?? "");
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function write(target, value) { const temp = `${target}.${process.pid}.${randomUUID()}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, target); }

export function cleanup(root, ttlHours) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const removed = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const target = file(root, entry.name);
    try {
      const state = JSON.parse(fs.readFileSync(target, "utf8"));
      const running = Object.values(state.providers ?? {}).some((item) => item.status === "running" && alive(item.pid));
      if (!running && (!Number.isFinite(state.expires_at_ms) || state.expires_at_ms <= now())) { fs.rmSync(path.join(root, entry.name), { recursive: true, force: true }); removed.push(entry.name); }
    } catch {
      // This root is broker-owned. A crash between temp-write and rename must
      // not create a directory that can never be collected.
      try { if (now() - fs.statSync(path.join(root, entry.name)).mtimeMs > ttlHours * 3_600_000) { fs.rmSync(path.join(root, entry.name), { recursive: true, force: true }); removed.push(entry.name); } } catch { /* leave a currently changing directory alone */ }
    }
  }
  return removed;
}

export function createRuntime(root, ttlHours, host) {
  const runtime_id = randomUUID(); const directory = path.join(root, runtime_id); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const state = { version: 4, runtime_id, host_provider: host, created_at_ms: now(), expires_at_ms: now() + ttlHours * 3_600_000, round: 0, providers: {} };
  write(path.join(directory, "state.json"), state); return state;
}

export function readRuntime(root, runtime_id) {
  if (!/^[0-9a-f-]{36}$/i.test(runtime_id)) fail("REQUEST_INVALID", "runtime_id must be a UUID");
  try { const state = JSON.parse(fs.readFileSync(file(root, runtime_id), "utf8")); if (state.runtime_id !== runtime_id) fail("RUNTIME_INVALID", "runtime state does not match runtime_id"); return state; }
  catch (error) { if (error?.code) throw error; fail("RUNTIME_NOT_FOUND", `runtime is unavailable: ${error.message}`); }
}

export function updateRuntime(root, runtime_id, update) {
  const state = readRuntime(root, runtime_id); const next = update(structuredClone(state)); write(file(root, runtime_id), next); return next;
}

export function runtimeDirectory(root, runtime_id) { const state = readRuntime(root, runtime_id); return path.join(root, state.runtime_id); }
export function isAlive(pid) { return Number.isInteger(pid) && pid > 0 && alive(pid); }
export function requestCancellation(root, runtime_id, provider) { fs.writeFileSync(path.join(runtimeDirectory(root, runtime_id), `.cancel-${provider}`), "1\n", { mode: 0o600 }); }
export function cancellationRequested(root, runtime_id, provider) { return fs.existsSync(path.join(runtimeDirectory(root, runtime_id), `.cancel-${provider}`)); }
export function terminateProcess(pid, signal = "SIGTERM") {
  if (!isAlive(pid)) return false;
  if (process.platform === "win32") return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).status === 0;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { return false; } }
  return true;
}
