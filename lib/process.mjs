import { spawn } from "node:child_process";
import { failureCode } from "./adapters/index.mjs";
import { isAlive, terminateProcessTree } from "./runtime.mjs";
import { createHealthRunner } from "./health-runner.mjs";

function redact(text, values) { let result = text; for (const value of values) if (value) result = result.split(value).join("[REDACTED]"); return result; }

export function execute(plan, { maxOutputBytes, terminationGraceMs = 5_000, terminateProcess = terminateProcessTree, livenessIntervalMs = 1000, healthCheckIntervalMs = 60_000, probeDeadlineMs = 5_000, probeSession = null, isProcessAlive = isAlive, isCancelled = () => false, validateCompleted = () => true, acceptSemanticOutputAfterStdinClose = false, onStart, onLiveness, onProgress, onActivity, onOutput }) {
  return new Promise((resolve) => {
    const started = Date.now(); let child; let stdout = ""; let stderr = ""; let bytes = 0; let stdoutTruncated = false; let stderrTruncated = false; let settled = false; let terminalClaim = null; let healthRunner = null; let livenessTimer = null; let killTimer = null; let lastProgressMs = null; let stdinError = null; const progressKeys = new Set(); let progressEvents = 0; let retryCount = 0; const lineBuffers = { stdout: "", stderr: "" };
    const cleanup = () => { if (livenessTimer) clearInterval(livenessTimer); if (killTimer) clearTimeout(killTimer); healthRunner?.stop(); if (child?.stdin && !child.stdin.destroyed) child.stdin.end(); livenessTimer = null; killTimer = null; };
    const finish = (value) => { if (settled) return; settled = true; cleanup(); resolve(value); };
    const snapshot = () => ({ stdout: redact(stdout, plan.redact), stderr: redact(stderr, plan.redact), stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated, duration_ms: Date.now() - started, last_progress_at_ms: lastProgressMs, progress_events: progressEvents, retry_count: retryCount });
    const terminateClaimedProcess = () => {
      if (terminateProcess(child.pid, "SIGTERM")) killTimer = setTimeout(() => { terminateProcess(child.pid, "SIGKILL"); }, terminationGraceMs).unref();
    };
    const claimFailure = (code, message) => { if (settled || terminalClaim) return false; terminalClaim = { kind: "failed", error: { code, message } }; terminateClaimedProcess(); return true; };
    const claimCompleted = (harvest) => { if (settled || terminalClaim) return false; terminalClaim = { kind: "completed", harvest }; terminateClaimedProcess(); return true; };
    const recordLiveness = () => { const at_ms = Date.now(); onLiveness?.({ at_ms }); return at_ms; };
    const observeProcessLiveness = () => { if (!settled && child?.pid && isProcessAlive(child.pid)) { recordLiveness(); return true; } return false; };
    try { plan.beforeSpawn?.(); child = spawn(plan.command, plan.argv, { cwd: plan.cwd, env: plan.env, stdio: ["pipe", "pipe", "pipe"], detached: false }); }
    catch (error) { finish({ ok: false, error: { code: error?.code ?? "PROCESS_START_FAILED", message: error.message }, duration_ms: Date.now() - started, stdout: "", stderr: "" }); return; }
    child.once("spawn", () => {
      child.stdin.once("error", (error) => { stdinError = { code: "PROCESS_STDIN_FAILED", message: `provider stdin failed: ${error.message}` }; });
      // Persisting PID identity may synchronously invoke ps. Deliver input
      // first, otherwise short-lived providers can exit before their prompt
      // reaches the pipe and turn a valid result into EPIPE.
      if (plan.input !== null) { if (plan.keepStdinOpen === true) child.stdin.write(plan.input); else child.stdin.end(plan.input); }
      else if (plan.keepStdinOpen !== true) child.stdin.end();
      onStart?.(child.pid); observeProcessLiveness();
      livenessTimer = setInterval(observeProcessLiveness, livenessIntervalMs); livenessTimer.unref();
      const healthProbe = probeSession ?? plan.probeSession;
      healthRunner = createHealthRunner({ intervalMs: healthCheckIntervalMs, probeDeadlineMs, isCancelled, validateCompleted, probeSession: healthProbe ? (ctx) => healthProbe({ ...ctx, pid: child.pid, cwd: plan.cwd }) : null, onDecision: (decision) => {
        if (decision.status === "completed") { claimCompleted(decision); return; }
        claimFailure(decision.error.code, decision.error.message);
      }, onDiagnostic: (diagnostic) => plan.onHealthDiagnostic?.(diagnostic) }); healthRunner.start();
    });
    child.once("error", (error) => { const value = snapshot(); finish({ ok: false, error: { code: "PROCESS_START_FAILED", message: error.message }, ...value }); });
    const appendSummary = (current, value) => {
      const limit = Math.max(1, maxOutputBytes ?? 1_048_576);
      if (Buffer.byteLength(current, "utf8") + Buffer.byteLength(value, "utf8") <= limit) return [current + value, false];
      const head = Math.max(1, Math.floor(limit / 4)); const tail = Math.max(1, limit - head);
      const combined = current + value;
      return [`${combined.slice(0, head)}\n[3rd-review raw stream retained privately; in-memory summary truncated]\n${combined.slice(-tail)}`, true];
    };
    const observeLine = (name, line) => {
      const observation = plan.observeLine?.(name, line) ?? {};
      retryCount += Number.isSafeInteger(observation.retry_count) ? observation.retry_count : 0;
      if (observation.liveness === true) recordLiveness();
      if (Object.hasOwn(observation, "stdin_write")) {
        if (typeof observation.stdin_write !== "string" || observation.stdin_write.length === 0) { claimFailure("PROCESS_STDIN_INVALID", "provider requested an invalid stdin write"); return; }
        if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) { claimFailure("PROCESS_STDIN_FAILED", "provider requested stdin after the channel closed"); return; }
        child.stdin.write(observation.stdin_write);
      }
      if (observation.terminal) {
        const terminal = observation.terminal;
        if (!terminal || !["completed", "failed"].includes(terminal.state)) { claimFailure("HEALTH_INVALID", "provider emitted an invalid terminal observation"); return; }
        if (isCancelled()) { claimFailure("CANCELLED", "health supervision was cancelled"); return; }
        if (terminal.state === "completed") {
          if (terminal.wait_for_close === true) { if (!terminalClaim && child.stdin && !child.stdin.destroyed) child.stdin.end(); }
          else {
            claimCompleted({ raw: { stdout: redact(stdout, plan.redact), stderr: redact(stderr, plan.redact) }, session_id: terminal.session_id ?? null, cursor: terminal.cursor ?? null });
          }
        } else claimFailure(terminal.error?.code ?? "PROVIDER_HEALTH_FAILED", terminal.error?.message ?? "provider emitted a failed terminal event");
      }
      if (observation.progress !== true) return;
      const progressKey = observation.progress_key ?? `${name}\0${line}`;
      if (progressKeys.has(progressKey)) return;
      progressKeys.add(progressKey); lastProgressMs = Date.now(); progressEvents += 1; healthRunner?.noteProgress({ cursor: observation.cursor, session_id: observation.session_id }); onProgress?.({ at_ms: lastProgressMs, event: observation.event ?? null });
    };
    const collect = (name) => (chunk) => {
      const value = chunk.toString(); bytes += Buffer.byteLength(value); (onOutput ?? plan.onOutput)?.({ stream: name, chunk: value });
      if (name === "stdout") { const [next, truncated] = appendSummary(stdout, value); stdout = next; stdoutTruncated ||= truncated; }
      else { const [next, truncated] = appendSummary(stderr, value); stderr = next; stderrTruncated ||= truncated; }
      onActivity?.();
      lineBuffers[name] += value;
      // Never split a JSONL record at a capture boundary: terminal protocol
      // events can be larger than the in-memory summary and remain valid only
      // after their newline arrives. The full raw stream is already on disk.
      const complete = lineBuffers[name].split(/\r?\n/); lineBuffers[name] = complete.pop();
      for (const line of complete) observeLine(name, line);
    };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.once("close", (code, signal) => {
      for (const [name, line] of Object.entries(lineBuffers)) if (line) observeLine(name, line);
      const value = snapshot();
      if (terminalClaim?.kind === "failed") return finish({ ok: false, error: terminalClaim.error, ...value });
      if (terminalClaim?.kind === "completed") return finish({ ok: true, ...value, stdout: terminalClaim.harvest.raw.stdout, stderr: terminalClaim.harvest.raw.stderr, health_harvested: true });
      if (code === 0 && stdinError && !acceptSemanticOutputAfterStdinClose) return finish({ ok: false, error: stdinError, ...value });
      if (code === 0) return finish({ ok: true, ...(stdinError ? { stdin_error: stdinError } : {}), ...value });
      if (signal) return finish({ ok: false, error: { code: "PROCESS_DEAD", message: `provider process was terminated by ${signal}` }, ...value });
      finish({ ok: false, error: { code: failureCode(`${value.stdout}\n${value.stderr}`), message: `provider process exited with ${signal ?? code}` }, ...value });
    });
  });
}
