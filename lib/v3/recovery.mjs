import fs from "node:fs";
import path from "node:path";
import { ProtocolError, RUNTIME_TTL_MS, validateProviderId, validateRuntimeId } from "./protocol.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RUNTIME_STATE = ".3rd-review-runtime.json";

function key(runtimeId, provider) { return `${runtimeId}:${provider}`; }
function providerState(provider) { return `.3rd-review-recovery-${provider}.json`; }
function providerLease(provider) { return `.3rd-review-recovery-${provider}.lock`; }

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new ProtocolError("CONTINUATION_FAILED", `${name} is required for continuation`);
  return value;
}

function requiredHash(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new ProtocolError("REQUEST_INVALID", `${name} must be sha256:<64 lowercase hex characters>`);
  return value;
}

function runtimeDirectory(value) {
  if (!path.isAbsolute(value)) throw new ProtocolError("REQUEST_INVALID", "runtime_path must be an absolute path");
  let fd;
  try {
    fd = fs.openSync(value, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isDirectory()) throw new ProtocolError("BINDING_MISMATCH", "runtime_path must be a real directory");
    fs.fchmodSync(fd, 0o700);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(error.code === "ELOOP" || error.code === "ENOTDIR" ? "BINDING_MISMATCH" : "RUNTIME_UNAVAILABLE", "runtime_path is unavailable or not private", { cause: error.code ?? error.message });
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* a failed close cannot make the path trusted */ }
  }
  return value;
}

function readJson(file, absent = null) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) throw new ProtocolError("BINDING_MISMATCH", "private state must be a real regular file");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return absent;
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(error.code === "ELOOP" ? "BINDING_MISMATCH" : "RUNTIME_UNAVAILABLE", "private recovery state is unreadable", { cause: error.message });
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* state was already read through a verified fd */ }
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    throw new ProtocolError("RUNTIME_UNAVAILABLE", "private recovery state could not be persisted", { cause: error.code ?? error.message });
  } finally {
    try { fs.unlinkSync(temp); } catch { /* atomically renamed or never created */ }
  }
}

function sameBinding(left, right) {
  return left.runtime_id === right.runtime_id && left.provider === right.provider && left.session_id === right.session_id
    && left.config_hash === right.config_hash && left.profile_hash === right.profile_hash && left.material_hash === right.material_hash;
}

function validState(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !sameBinding(value, expected)
    || !Number.isSafeInteger(value.recovery_count) || value.recovery_count < 0
    || !Number.isFinite(value.created_at_ms) || !Number.isFinite(value.last_success_at_ms) || !Number.isFinite(value.expires_at_ms)) {
    throw new ProtocolError("BINDING_MISMATCH", "persisted recovery state does not match this runtime/provider binding");
  }
  return value;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

export class AttemptLocks {
  #locks = new Set();

  acquire(id, { lease_path = null } = {}) {
    if (typeof id !== "string" || id.length === 0) throw new ProtocolError("REQUEST_INVALID", "lock id must be non-empty");
    if (this.#locks.has(id)) throw new ProtocolError("DUPLICATE_ACTIVE_REQUEST", `operation already active: ${id}`);
    this.#locks.add(id);
    let fd = null;
    try {
      if (lease_path !== null) {
        runtimeDirectory(path.dirname(lease_path));
        try { fd = fs.openSync(lease_path, "wx", 0o600); } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const prior = readJson(lease_path, null);
          if (prior && !pidAlive(prior.pid)) {
            fs.unlinkSync(lease_path);
            fd = fs.openSync(lease_path, "wx", 0o600);
          } else {
            throw new ProtocolError("DUPLICATE_ACTIVE_REQUEST", `operation already active: ${id}`);
          }
        }
        fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, started_at_ms: Date.now() })}\n`, "utf8");
        fs.fchmodSync(fd, 0o600);
      }
    } catch (error) {
      try { if (fd !== null) fs.closeSync(fd); } catch { /* best effort */ }
      try { if (fd !== null && lease_path !== null) fs.unlinkSync(lease_path); } catch { /* a later process can reclaim a dead lease */ }
      this.#locks.delete(id);
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("RUNTIME_UNAVAILABLE", "continuation lease could not be acquired", { cause: error.code ?? error.message });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { if (fd !== null) fs.closeSync(fd); } catch { /* best effort */ }
      try { if (lease_path !== null) fs.unlinkSync(lease_path); } catch { /* lease will be reclaimed only after owner process is gone */ }
      this.#locks.delete(id);
    };
  }
}

function hasLiveLease(runtimePath) {
  let entries;
  try { entries = fs.readdirSync(runtimePath, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  for (const entry of entries) {
    if (entry.isFile() && !entry.isSymbolicLink() && entry.name === ".3rd-review-active.json") {
      const active = readJson(path.join(runtimePath, entry.name), null);
      if (active && active.terminal !== true && pidAlive(active.pid)) return true;
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith(".3rd-review-recovery-") || !entry.name.endsWith(".lock")) continue;
    const lease = path.join(runtimePath, entry.name);
    const prior = readJson(lease, null);
    if (prior && pidAlive(prior.pid)) return true;
    try { fs.unlinkSync(lease); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return false;
}

export class RecoveryLedger {
  #entries = new Map();

  constructor({ now = () => Date.now(), locks = new AttemptLocks() } = {}) {
    this.now = now;
    this.locks = locks;
  }

  record({ runtime_id, provider, session_id, config_hash, profile_hash, material_hash, runtime_path }) {
    validateRuntimeId(runtime_id); validateProviderId(provider);
    const binding = {
      runtime_id, provider, session_id: required(session_id, "session_id"),
      config_hash: requiredHash(config_hash, "config_hash"), profile_hash: requiredHash(profile_hash, "profile_hash"), material_hash: requiredHash(material_hash, "material_hash"),
    };
    const root = runtimeDirectory(runtime_path);
    const entryKey = key(runtime_id, provider);
    const existing = this.#entries.get(entryKey);
    if (existing) {
      if (existing.runtime_path !== root || !sameBinding(existing, binding)) throw new ProtocolError("BINDING_MISMATCH", "recovery entry cannot be replaced");
      return;
    }
    const persisted = readJson(path.join(root, providerState(provider)), null);
    const createdAt = this.now();
    const state = persisted === null
      ? { ...binding, recovery_count: 0, created_at_ms: createdAt, last_success_at_ms: createdAt, expires_at_ms: createdAt + RUNTIME_TTL_MS }
      : validState(persisted, binding);
    if (persisted === null) writeJsonAtomic(path.join(root, providerState(provider)), state);
    const runtimeStatePath = path.join(root, RUNTIME_STATE);
    if (readJson(runtimeStatePath, null) === null) writeJsonAtomic(runtimeStatePath, { last_success_at_ms: createdAt, expires_at_ms: createdAt + RUNTIME_TTL_MS });
    this.#entries.set(entryKey, { ...state, runtime_path: root });
  }

  restore({ runtime_id, provider, runtime_path }) {
    validateRuntimeId(runtime_id); validateProviderId(provider);
    const root = runtimeDirectory(runtime_path);
    const state = readJson(path.join(root, providerState(provider)), null);
    if (!state || state.runtime_id !== runtime_id || state.provider !== provider) {
      throw new ProtocolError("CONTINUATION_FAILED", "provider has no recorded recovery state");
    }
    const expected = {
      runtime_id, provider, session_id: state.session_id,
      config_hash: state.config_hash, profile_hash: state.profile_hash, material_hash: state.material_hash,
    };
    const entry = validState(state, expected);
    this.#entries.set(key(runtime_id, provider), { ...entry, runtime_path: root });
    return this.#entries.get(key(runtime_id, provider));
  }

  async resumeOnce(context, run) { return this.#continue(context, run); }

  async repairOnce(context, run) {
    if (context.error_code !== "INVALID_JSON") throw new ProtocolError("CONTINUATION_FAILED", "only complete invalid JSON may be repaired");
    return this.#continue(context, run);
  }

  async #continue(context, run) {
    validateRuntimeId(context.runtime_id); validateProviderId(context.provider);
    if (typeof run !== "function") throw new TypeError("continuation runner is required");
    const entryKey = key(context.runtime_id, context.provider);
    const original = this.#entries.get(entryKey);
    if (!original) throw new ProtocolError("CONTINUATION_FAILED", "provider has no recorded recovery state");
    const lock = this.locks.acquire(`continuation:${entryKey}`, { lease_path: path.join(original.runtime_path, providerLease(context.provider)) });
    try {
      const statePath = path.join(original.runtime_path, providerState(context.provider));
      const entry = validState(readJson(statePath), original);
      this.#entries.set(entryKey, { ...entry, runtime_path: original.runtime_path });
      if (entry.session_id !== required(context.session_id, "session_id")) throw new ProtocolError("CONTINUATION_FAILED", "provider has no matching native session");
      if (this.now() > entry.expires_at_ms) throw new ProtocolError("CONTINUATION_FAILED", "continuation runtime expired");
      if (entry.config_hash !== requiredHash(context.config_hash, "config_hash") || entry.profile_hash !== requiredHash(context.profile_hash, "profile_hash")) throw new ProtocolError("CONFIG_SNAPSHOT_CHANGED", "continuation profile changed");
      if (entry.material_hash !== requiredHash(context.material_hash, "material_hash")) throw new ProtocolError("BINDING_MISMATCH", "continuation material changed");
      if (entry.recovery_count >= 1) throw new ProtocolError("CONTINUATION_FAILED", "resume or repair was already attempted");
      entry.recovery_count += 1;
      writeJsonAtomic(statePath, entry);
      const result = await run({ runtime_id: context.runtime_id, provider: context.provider, session_id: entry.session_id, resume_input: required(context.resume_input, "resume_input") });
      if (result?.execution_eligible === true) {
        const succeededAt = this.now();
        entry.last_success_at_ms = succeededAt;
        entry.expires_at_ms = succeededAt + RUNTIME_TTL_MS;
        writeJsonAtomic(statePath, entry);
        writeJsonAtomic(path.join(original.runtime_path, RUNTIME_STATE), { last_success_at_ms: succeededAt, expires_at_ms: entry.expires_at_ms });
      }
      return result;
    } finally {
      lock();
    }
  }
}

export function gcExpiredRuntimes({ runtime_root, now = Date.now(), is_active = () => false }) {
  const removed = [];
  let entries;
  try { entries = fs.readdirSync(runtime_root, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return removed; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || is_active(entry.name)) continue;
    const candidate = path.join(runtime_root, entry.name);
    let stat;
    try { stat = fs.lstatSync(candidate); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || hasLiveLease(candidate)) continue;
    const runtime = readJson(path.join(candidate, RUNTIME_STATE), null);
    if (runtime === null || !Number.isFinite(runtime.expires_at_ms) || now <= runtime.expires_at_ms) continue;
    fs.rmSync(candidate, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
