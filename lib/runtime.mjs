import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";
import { providerRuntimeKey } from "./provider-ids.mjs";

function file(root, id) { return path.join(root, id, "state.json"); }
function now() { return Date.now(); }
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const cancellationSources = new Set(["user", "workflow_shutdown", "broker_idle_timeout", "broker_max_duration"]);
export const INVALID_CANCELLATION_SOURCE = "invalid";
function pause(ms = 2) { Atomics.wait(waitBuffer, 0, 0, ms); }
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
    return result.status === 0 && new RegExp(`\\b${pid}\\b`).test(result.stdout ?? "");
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function write(target, value) { const temp = `${target}.${process.pid}.${randomUUID()}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, target); }
function owner(directory) { try { return JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8")); } catch { return null; } }
function stale(directory, graceMs) {
  const current = owner(directory); if (current && Number.isInteger(current.pid)) return !alive(current.pid);
  try { return now() - fs.statSync(directory).mtimeMs > graceMs; } catch { return true; }
}
function acquireStateLock(root, runtime_id) {
  const runtime = path.join(root, runtime_id); const directory = path.join(runtime, ".state-lock"); const reaper = path.join(runtime, ".state-lock-reaper"); const token = randomUUID(); const deadline = now() + 5_000;
  while (now() < deadline) {
    if (fs.existsSync(reaper)) { pause(); continue; }
    try { fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, "owner.json"), `${JSON.stringify({ version: 1, token, pid: process.pid, created_at_ms: now() })}\n`, { mode: 0o600, flag: "wx" }); return { directory, token }; }
    catch (error) {
      if (error?.code !== "EEXIST") { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } throw error; }
      try { fs.mkdirSync(reaper, { mode: 0o700 }); try { if (stale(directory, 30_000)) fs.rmSync(directory, { recursive: true, force: true }); } finally { fs.rmSync(reaper, { recursive: true, force: true }); } }
      catch (reapError) { if (reapError?.code !== "EEXIST") throw reapError; pause(); }
    }
  }
  fail("RUNTIME_BUSY", "runtime state is locked by another broker");
}
function releaseLock(claim) {
  try { if (owner(claim.directory)?.token === claim.token) fs.rmSync(claim.directory, { recursive: true, force: true }); } catch { /* a crashed owner is recovered by the next caller */ }
}

export function cleanup(root, ttlHours) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const removed = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const target = file(root, entry.name);
    try {
      let state = JSON.parse(fs.readFileSync(target, "utf8"));
      const timeout = Number.isSafeInteger(state.orphan_timeout_ms) ? state.orphan_timeout_ms : 30_000;
      const orphaned = Object.entries(state.providers ?? {}).filter(([, item]) => {
        if (item.status !== "running") return false;
        const ownerMissing = !state.owner || !alive(state.owner.pid);
        const livenessExpired = !Number.isFinite(item.process_alive_at_ms) || now() - item.process_alive_at_ms > timeout;
        return ownerMissing || livenessExpired;
      });
      if (orphaned.length > 0) {
        const completed = now();
        for (const [, item] of orphaned) terminateProcessTree(item.pid, "SIGTERM");
        state = {
          ...state,
          providers: Object.fromEntries(Object.entries(state.providers).map(([id, item]) => {
            const reason = orphaned.find(([provider]) => provider === id);
            if (!reason) return [id, item];
            return [id, { ...item, status: "failed", completed_at_ms: completed, error: { code: "ORPHANED_BROKER", message: "provider outlived its broker or its liveness lease" }, cancellation_source: "broker_lost" }];
          })),
        };
        write(target, state);
      }
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

export function createRuntime(root, ttlHours, host, orphanTimeoutMs = 30_000) {
  const runtime_id = randomUUID(); const directory = path.join(root, runtime_id); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const state = { version: 4, runtime_id, host_provider: host, created_at_ms: now(), expires_at_ms: now() + ttlHours * 3_600_000, orphan_timeout_ms: orphanTimeoutMs, owner: { pid: process.pid, started_at_ms: now() }, round: 0, providers: {} };
  write(path.join(directory, "state.json"), state); return state;
}

export function readRuntime(root, runtime_id) {
  if (!/^[0-9a-f-]{36}$/i.test(runtime_id)) fail("REQUEST_INVALID", "runtime_id must be a UUID");
  try { const state = JSON.parse(fs.readFileSync(file(root, runtime_id), "utf8")); if (state.runtime_id !== runtime_id) fail("RUNTIME_INVALID", "runtime state does not match runtime_id"); return state; }
  catch (error) { if (error?.code) throw error; fail("RUNTIME_NOT_FOUND", `runtime is unavailable: ${error.message}`); }
}

export function updateRuntime(root, runtime_id, update) {
  const claim = acquireStateLock(root, runtime_id);
  try { const state = readRuntime(root, runtime_id); const next = update(structuredClone(state)); write(file(root, runtime_id), next); return next; }
  finally { releaseLock(claim); }
}

export function updateRunningProvider(root, runtime_id, provider, patch) {
  return updateRuntime(root, runtime_id, (next) => {
    const current = next.providers?.[provider];
    if (!current || current.status !== "running") return next;
    return { ...next, providers: { ...next.providers, [provider]: { ...current, ...patch } } };
  });
}

export function runtimeDirectory(root, runtime_id) { const state = readRuntime(root, runtime_id); return path.join(root, state.runtime_id); }
export function isAlive(pid) { return Number.isInteger(pid) && pid > 0 && alive(pid); }
export function requestCancellation(root, runtime_id, provider, source = "user") {
  if (!cancellationSources.has(source)) fail("REQUEST_INVALID", "cancel source must be user, workflow_shutdown, broker_idle_timeout, or broker_max_duration");
  const key = providerRuntimeKey(provider) ?? provider;
  write(path.join(runtimeDirectory(root, runtime_id), `.cancel-${key}`), { version: 1, source });
}
export function cancellationSource(root, runtime_id, provider) {
  const key = providerRuntimeKey(provider) ?? provider;
  try { const raw = fs.readFileSync(path.join(runtimeDirectory(root, runtime_id), `.cancel-${key}`), "utf8").trim(); try { const value = JSON.parse(raw); return value?.version === 1 && cancellationSources.has(value.source) ? value.source : INVALID_CANCELLATION_SOURCE; } catch { return cancellationSources.has(raw) ? raw : INVALID_CANCELLATION_SOURCE; } }
  catch { return null; }
}
export function cancellationRequested(root, runtime_id, provider) { return cancellationSource(root, runtime_id, provider) !== null; }
export function claimProvider(root, runtime_id, provider, staleMs = 30_000) {
  const key = providerRuntimeKey(provider) ?? provider;
  const claims = path.join(runtimeDirectory(root, runtime_id), ".claims"); fs.mkdirSync(claims, { recursive: true, mode: 0o700 }); const directory = path.join(claims, key); const reaper = path.join(claims, `.reap-${key}`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    try { fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, "owner.json"), `${JSON.stringify({ version: 1, token, pid: process.pid, created_at_ms: now() })}\n`, { mode: 0o600, flag: "wx" }); return { directory, token }; }
    catch (error) {
      if (error?.code !== "EEXIST") { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } throw error; }
      try {
        fs.mkdirSync(reaper, { mode: 0o700 });
        try { if (stale(directory, staleMs)) fs.rmSync(directory, { recursive: true, force: true }); else return null; }
        finally { fs.rmSync(reaper, { recursive: true, force: true }); }
      } catch (reapError) { if (reapError?.code !== "EEXIST") throw reapError; pause(); }
    }
  }
  return null;
}
export function releaseProviderClaim(claim) { if (claim) releaseLock(claim); }
export function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!isAlive(pid)) return false;
  if (process.platform === "win32") return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).status === 0;
  const descendants = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", windowsHide: true });
  for (const child of String(descendants.stdout ?? "").trim().split(/\s+/).filter(Boolean).map(Number)) terminateProcessTree(child, signal);
  try { process.kill(pid, signal); } catch { return false; }
  return true;
}

export const terminateProcess = terminateProcessTree;
