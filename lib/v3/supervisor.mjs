import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { ProtocolError, validateProviderId, validateRuntimeId } from "./protocol.mjs";

function attemptId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ProtocolError("REQUEST_INVALID", "attempt_id must be opaque");
  return value;
}

function privateDir(root, runtimeId, provider) {
  const normalizedRoot = path.resolve(root);
  fs.mkdirSync(normalizedRoot, { recursive: true, mode: 0o700 });
  const checked = [normalizedRoot];
  const runtimeDirectory = path.join(normalizedRoot, runtimeId);
  const directory = path.join(runtimeDirectory, provider);
  if (!runtimeDirectory.startsWith(`${normalizedRoot}${path.sep}`) || !directory.startsWith(`${runtimeDirectory}${path.sep}`)) {
    throw new ProtocolError("BINDING_MISMATCH", "runtime path escapes private root");
  }
  try { fs.lstatSync(runtimeDirectory); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
  }
  checked.push(runtimeDirectory);
  try { fs.lstatSync(directory); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  checked.push(directory);
  for (const candidate of checked) {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProtocolError("BINDING_MISMATCH", "private runtime must not contain symlinks");
    fs.chmodSync(candidate, 0o700);
  }
  return directory;
}

function privateFile(file) {
  const fd = fs.openSync(file, "w", 0o600);
  fs.fchmodSync(fd, 0o600);
  return { file, fd };
}

function closePrivateFile(file) {
  try {
    fs.closeSync(file.fd);
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
}

function writePrivateJson(file, value) {
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(temp, 0o600);
    const fileFd = fs.openSync(temp, "r");
    try { fs.fsyncSync(fileFd); } finally { fs.closeSync(fileFd); }
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
    const directoryFd = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* atomically renamed or never created */ }
  }
}

function processFingerprint(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return value || null;
  } catch { return null; }
}

function readPrivateJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new ProtocolError("BINDING_MISMATCH", "active attempt state must be an owner-only real file");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("RUNTIME_UNAVAILABLE", "active attempt state cannot be read", { cause: error.code ?? error.message });
  }
}

export function cancelPersistedAttempt({ active_path, attempt_id }) {
  const state = readPrivateJson(active_path);
  if (!state || state.terminal === true) return false;
  if (state.attempt_id !== attempt_id) throw new ProtocolError("BINDING_MISMATCH", "attempt id does not match active runtime state");
  if (state.pid_fingerprint && state.pid_fingerprint !== processFingerprint(state.pid)) throw new ProtocolError("PROCESS_DIED", "active process identity changed before cancellation");
  writePrivateJson(active_path, { ...state, cancel_requested: true, cancel_requested_at_ms: Date.now() });
  try { process.kill(-state.pid, "SIGINT"); } catch (error) {
    if (error.code === "ESRCH") return false;
    throw new ProtocolError("RUNTIME_UNAVAILABLE", "active process cannot be cancelled", { cause: error.code ?? error.message });
  }
  return true;
}

function killProcessGroup(child, signal) {
  if (process.platform === "win32" && child.pid) {
    if (signal === "SIGINT") {
      try { child.kill(signal); return; } catch { /* fall through */ }
    }
    try {
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      return;
    } catch { /* fall through */ }
  }
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
  }
  try { child.kill(signal); } catch { /* process already gone */ }
}

export class CliSupervisor {
  #attempts = new Map();

  constructor({ runtimeRoot = path.join(tmpdir(), "3rd-review"), pollIntervalMs = 5_000, cancelGraceMs = 1_000, now = () => Date.now() } = {}) {
    this.runtimeRoot = runtimeRoot;
    this.pollIntervalMs = pollIntervalMs;
    this.cancelGraceMs = cancelGraceMs;
    this.now = now;
  }

  status(id) {
    const state = this.#attempts.get(id);
    if (!state) return null;
    const { child, promise, timers, ...visible } = state;
    return structuredClone(visible);
  }

  cancel(id) {
    const state = this.#attempts.get(id);
    if (!state) return false;
    if (state.terminal || state.stop_reason) return state.stop_reason === "cancelled";
    this.#terminate(state, "cancelled");
    return true;
  }

  pruneTerminalBefore(beforeMs) {
    if (!Number.isFinite(beforeMs)) throw new ProtocolError("REQUEST_INVALID", "beforeMs must be finite");
    let removed = 0;
    for (const [id, state] of this.#attempts) {
      if (state.terminal && state.finished_at_ms < beforeMs) {
        this.#attempts.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  run(plan) {
    const id = attemptId(plan?.attempt_id);
    if (this.#attempts.has(id)) throw new ProtocolError("DUPLICATE_ACTIVE_REQUEST", `attempt already exists: ${id}`);
    validateRuntimeId(plan.runtime_id);
    validateProviderId(plan.provider);
    if (typeof plan.command !== "string" || !path.isAbsolute(plan.command)) throw new ProtocolError("REQUEST_INVALID", "command must be an absolute path");
    if (!Array.isArray(plan.argv) || !plan.argv.every((value) => typeof value === "string")) throw new ProtocolError("REQUEST_INVALID", "argv must be string[]");
    if (plan.deadline_seconds !== undefined && plan.deadline_seconds !== null && (!Number.isFinite(plan.deadline_seconds) || plan.deadline_seconds <= 0)) {
      throw new ProtocolError("REQUEST_INVALID", "deadline_seconds must be null or positive");
    }
    const maxOutput = plan.max_output_bytes ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(maxOutput) || maxOutput < 1) throw new ProtocolError("REQUEST_INVALID", "max_output_bytes must be positive");

    let directory; let stdoutPath; let stderrPath; let receiptPath; let stdout; let stderr;
    try {
      directory = privateDir(this.runtimeRoot, plan.runtime_id, plan.provider);
      stdoutPath = path.join(directory, `${id}.stdout`);
      stderrPath = path.join(directory, `${id}.stderr`);
      receiptPath = path.join(directory, `${id}.receipt.json`);
      stdout = privateFile(stdoutPath);
      stderr = privateFile(stderrPath);
    } catch (error) {
      try { if (stdout) fs.closeSync(stdout.fd); } catch { /* best effort */ }
      try { if (stderr) fs.closeSync(stderr.fd); } catch { /* best effort */ }
      if (error instanceof ProtocolError) throw error;
      return this.#persistenceFailure(id, plan, error);
    }
    let child;
    try {
      child = spawn(plan.command, plan.argv, {
        cwd: plan.cwd ?? process.cwd(),
        env: plan.env ?? {},
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const stdoutCloseError = closePrivateFile(stdout);
      const stderrCloseError = closePrivateFile(stderr);
      return this.#launchFailure(id, plan, error, { stdoutPath, stderrPath, receiptPath, closeError: stdoutCloseError ?? stderrCloseError });
    }
    const state = {
      attempt_id: id, runtime_id: plan.runtime_id, provider: plan.provider,
      status: "running", error_code: null, persisted: true,
      pid: child.pid ?? null, stdout_path: stdoutPath, stderr_path: stderrPath, receipt_path: receiptPath,
      started_at_ms: this.now(), last_activity_ms: this.now(), last_heartbeat_ms: this.now(), activity_count: 0,
      output_bytes: 0, terminal: false, accept_output: true, child, timers: [], promise: null,
      active_path: typeof plan.active_path === "string" ? plan.active_path : null, pid_fingerprint: processFingerprint(child.pid),
    };
    const persistActive = () => {
      if (!state.active_path) return;
      try {
        const prior = readPrivateJson(state.active_path);
        writePrivateJson(state.active_path, { attempt_id: state.attempt_id, runtime_id: state.runtime_id, provider: state.provider, pid: state.pid, pid_fingerprint: state.pid_fingerprint, status: state.status, terminal: state.terminal, last_activity_ms: state.last_activity_ms, last_heartbeat_ms: state.last_heartbeat_ms, started_at_ms: state.started_at_ms, cancel_requested: prior?.cancel_requested === true });
      } catch (error) { state.persistence_error = error.code ?? error.message; this.#terminate(state, "runtime_unavailable"); }
    };
    this.#attempts.set(id, state);
    persistActive();
    const observe = (file) => (chunk) => {
      if (!state.accept_output) return;
      state.last_activity_ms = this.now();
      state.activity_count += 1;
      const available = maxOutput - state.output_bytes;
      try {
        if (available > 0) fs.writeSync(file.fd, chunk, 0, Math.min(chunk.length, available));
      } catch (error) {
        state.persistence_error = error.code ?? error.message;
        this.#terminate(state, "runtime_unavailable");
        return;
      }
      state.output_bytes += chunk.length;
      if (state.output_bytes > maxOutput && !state.terminal) this.#terminate(state, "output_limit");
    };
    child.stdout.on("data", observe(stdout));
    child.stderr.on("data", observe(stderr));
    child.on("error", (error) => { state.spawn_error = error.code ?? error.message; });
    if (plan.input !== undefined && plan.input !== null) child.stdin.end(plan.input); else child.stdin.end();
    if (plan.deadline_seconds !== undefined && plan.deadline_seconds !== null) {
      state.timers.push(setTimeout(() => this.#terminate(state, "deadline_exceeded"), plan.deadline_seconds * 1_000));
    }
    state.timers.push(setInterval(() => { if (!state.terminal) { state.last_heartbeat_ms = this.now(); persistActive(); } }, this.pollIntervalMs));
    state.promise = new Promise((resolve) => child.on("close", (exitCode, signal) => {
      state.terminal = true;
      for (const timer of state.timers) clearTimeout(timer);
      if (!state.stop_reason && state.active_path && readPrivateJson(state.active_path)?.cancel_requested === true) state.stop_reason = "cancelled";
      const stdoutCloseError = closePrivateFile(stdout);
      const stderrCloseError = closePrivateFile(stderr);
      const closeError = stdoutCloseError ?? stderrCloseError;
      if (state.stop_reason === "deadline_exceeded") { state.status = "deadline_exceeded"; state.error_code = "DEADLINE_EXCEEDED"; }
      else if (state.stop_reason === "cancelled") { state.status = "cancelled"; state.error_code = "CANCELLED"; }
      else if (state.stop_reason === "output_limit") { state.status = "failed"; state.error_code = "OUTPUT_LIMIT"; }
      else if (state.stop_reason === "runtime_unavailable") { state.status = "failed"; state.error_code = "RUNTIME_UNAVAILABLE"; state.persisted = false; }
      else if (state.spawn_error) { state.status = "failed"; state.error_code = "PROCESS_DIED"; }
      else if (exitCode !== 0) { state.status = "failed"; state.error_code = "PROCESS_EXIT_NONZERO"; }
      else { state.status = "completed"; state.error_code = null; }
      state.exit_code = exitCode; state.signal = signal; state.finished_at_ms = this.now();
      if (closeError) {
        state.status = "failed";
        state.error_code = "RUNTIME_UNAVAILABLE";
        state.persisted = false;
        state.persistence_error = closeError;
      }
      try {
        writePrivateJson(receiptPath, {
          attempt_id: state.attempt_id, runtime_id: state.runtime_id, provider: state.provider,
          status: state.status, error_code: state.error_code, pid: state.pid,
          exit_code: state.exit_code, signal: state.signal, started_at_ms: state.started_at_ms,
          finished_at_ms: state.finished_at_ms, activity_count: state.activity_count,
          output_bytes: state.output_bytes, stdout_file: path.basename(stdoutPath), stderr_file: path.basename(stderrPath),
        });
      } catch (error) {
        state.status = "failed";
        state.error_code = "RUNTIME_UNAVAILABLE";
        state.persisted = false;
        state.persistence_error = error.code ?? error.message;
      }
      persistActive();
      resolve(this.status(id));
    }));
    return state.promise;
  }

  #terminate(state, reason) {
    if (state.terminal || state.stop_reason) return;
    state.stop_reason = reason;
    state.accept_output = false;
    killProcessGroup(state.child, "SIGINT");
    state.timers.push(setTimeout(() => killProcessGroup(state.child, "SIGTERM"), this.cancelGraceMs));
    state.timers.push(setTimeout(() => killProcessGroup(state.child, "SIGKILL"), this.cancelGraceMs * 2));
  }

  #persistenceFailure(id, plan, error) {
    const now = this.now();
    const state = {
      attempt_id: id, runtime_id: plan.runtime_id, provider: plan.provider,
      status: "failed", error_code: "RUNTIME_UNAVAILABLE", persisted: false,
      pid: null, stdout_path: null, stderr_path: null, receipt_path: null,
      started_at_ms: now, last_activity_ms: now, last_heartbeat_ms: now, activity_count: 0,
      output_bytes: 0, terminal: true, exit_code: null, signal: null, finished_at_ms: now,
      persistence_error: error.code ?? error.message, child: null, timers: [], promise: null,
    };
    this.#attempts.set(id, state);
    state.promise = Promise.resolve(this.status(id));
    return state.promise;
  }

  #launchFailure(id, plan, error, paths) {
    const now = this.now();
    const state = {
      attempt_id: id, runtime_id: plan.runtime_id, provider: plan.provider,
      status: "failed", error_code: "PROCESS_DIED", persisted: true,
      pid: null, stdout_path: paths.stdoutPath, stderr_path: paths.stderrPath, receipt_path: paths.receiptPath,
      started_at_ms: now, last_activity_ms: now, last_heartbeat_ms: now, activity_count: 0,
      output_bytes: 0, terminal: true, exit_code: null, signal: null, finished_at_ms: now,
      spawn_error: error.code ?? error.message, close_error: paths.closeError ?? null, child: null, timers: [], promise: null,
    };
    try {
      writePrivateJson(paths.receiptPath, {
        attempt_id: state.attempt_id, runtime_id: state.runtime_id, provider: state.provider,
        status: state.status, error_code: state.error_code, spawn_error: state.spawn_error,
        stdout_file: path.basename(paths.stdoutPath), stderr_file: path.basename(paths.stderrPath),
      });
    } catch (receiptError) {
      state.status = "failed";
      state.error_code = "RUNTIME_UNAVAILABLE";
      state.persisted = false;
      state.persistence_error = receiptError.code ?? receiptError.message;
    }
    this.#attempts.set(id, state);
    state.promise = Promise.resolve(this.status(id));
    return state.promise;
  }
}
