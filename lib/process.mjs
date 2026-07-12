import { spawn } from "node:child_process";
import { failureCode } from "./adapters/index.mjs";
import { isAlive, terminateProcess } from "./runtime.mjs";

function redact(text, values) { let result = text; for (const value of values) if (value) result = result.split(value).join("[REDACTED]"); return result; }

export function execute(plan, { maxOutputBytes, idleTimeoutMs = 0, maxDurationMs = 0, livenessIntervalMs = 1000, onStart, onLiveness, onActivity }) {
  return new Promise((resolve) => {
    const started = Date.now(); let child; let stdout = ""; let stderr = ""; let bytes = 0; let overflow = false; let settled = false; let termination = null; let livenessTimer = null; let idleTimer = null; let durationTimer = null; let killTimer = null; let lastActivityMs = started; let idleGeneration = 0;
    const cleanup = () => { if (livenessTimer) clearInterval(livenessTimer); if (idleTimer) clearTimeout(idleTimer); if (durationTimer) clearTimeout(durationTimer); if (killTimer) clearTimeout(killTimer); livenessTimer = null; idleTimer = null; durationTimer = null; killTimer = null; };
    const finish = (value) => { if (settled) return; settled = true; cleanup(); resolve(value); };
    const snapshot = () => ({ stdout: redact(stdout, plan.redact), stderr: redact(stderr, plan.redact), duration_ms: Date.now() - started });
    const stop = (code, message) => {
      if (settled) return;
      // A total-duration limit is the more specific terminal diagnosis when
      // both timers mature in the same event-loop turn. Do not let either
      // timeout override output-limit termination.
      if (termination) {
        if (code === "PROCESS_TIMEOUT" && termination.code === "IDLE_TIMEOUT") termination = { code, message };
        return;
      }
      termination = { code, message };
      if (terminateProcess(child.pid, "SIGTERM")) killTimer = setTimeout(() => { terminateProcess(child.pid, "SIGKILL"); }, 5_000).unref();
    };
    const resetIdleTimer = () => {
      const generation = ++idleGeneration;
      if (idleTimeoutMs === 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      const checkIdle = () => {
        if (settled || generation !== idleGeneration) return;
        const remaining = idleTimeoutMs - (Date.now() - lastActivityMs);
        if (remaining > 0) { idleTimer = setTimeout(checkIdle, remaining); idleTimer.unref(); return; }
        stop("IDLE_TIMEOUT", `provider produced no stdout/stderr activity for ${idleTimeoutMs} ms`);
      };
      idleTimer = setTimeout(checkIdle, idleTimeoutMs);
      idleTimer.unref();
    };
    const observeLiveness = () => { if (!settled && child?.pid && isAlive(child.pid)) onLiveness?.(); };
    try { child = spawn(plan.command, plan.argv, { cwd: plan.cwd, env: plan.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }); }
    catch (error) { finish({ ok: false, error: { code: "PROCESS_START_FAILED", message: error.message }, duration_ms: Date.now() - started, stdout: "", stderr: "" }); return; }
    child.once("spawn", () => {
      lastActivityMs = Date.now(); onStart?.(child.pid); observeLiveness();
      livenessTimer = setInterval(observeLiveness, livenessIntervalMs); livenessTimer.unref();
      if (maxDurationMs > 0) { durationTimer = setTimeout(() => stop("PROCESS_TIMEOUT", `provider exceeded ${maxDurationMs} ms maximum duration`), maxDurationMs); durationTimer.unref(); }
      resetIdleTimer();
      if (plan.input !== null) child.stdin.end(plan.input); else child.stdin.end();
    });
    child.once("error", (error) => { const value = snapshot(); finish({ ok: false, error: { code: "PROCESS_START_FAILED", message: error.message }, ...value }); });
    const terminate = () => {
      stop("OUTPUT_TOO_LARGE", `provider output exceeded ${maxOutputBytes} bytes`);
    };
    const collect = (name) => (chunk) => { const value = chunk.toString(); bytes += Buffer.byteLength(value); if (!overflow) { if (name === "stdout") stdout += value; else stderr += value; } lastActivityMs = Date.now(); onActivity?.(); resetIdleTimer(); if (bytes > maxOutputBytes && !overflow) { overflow = true; terminate(); } };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.once("close", (code, signal) => {
      const value = snapshot();
      if (overflow) return finish({ ok: false, error: { code: "OUTPUT_TOO_LARGE", message: `provider output exceeded ${maxOutputBytes} bytes` }, ...value });
      if (termination) return finish({ ok: false, error: termination, ...value });
      if (code === 0) return finish({ ok: true, ...value });
      finish({ ok: false, error: { code: failureCode(`${value.stdout}\n${value.stderr}`), message: `provider process exited with ${signal ?? code}` }, ...value });
    });
  });
}
