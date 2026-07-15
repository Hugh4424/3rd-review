import { spawn } from "node:child_process";
import { failureCode } from "./adapters/index.mjs";
import { isAlive, terminateProcessTree } from "./runtime.mjs";
import { createHealthRunner } from "./health-runner.mjs";

function redact(text, values) { let result = text; for (const value of values) if (value) result = result.split(value).join("[REDACTED]"); return result; }

export function execute(plan, { maxOutputBytes, maxWallClockMs = null, terminationGraceMs = 5_000, terminateProcess = terminateProcessTree, livenessIntervalMs = 1000, healthCheckIntervalMs = 60_000, probeDeadlineMs = 5_000, probeSession = null, isProcessAlive = isAlive, isCancelled = () => false, validateCompleted = () => true, onStart, onLiveness, onProgress, onActivity }) {
  return new Promise((resolve) => {
    const started = Date.now(); let child; let stdout = ""; let stderr = ""; let bytes = 0; let overflow = false; let settled = false; let terminalClaim = null; let healthRunner = null; let livenessTimer = null; let budgetTimer = null; let killTimer = null; let lastProgressMs = null; const progressKeys = new Set(); let progressEvents = 0; let retryCount = 0; const lineBuffers = { stdout: "", stderr: "" };
    const cleanup = () => { if (livenessTimer) clearInterval(livenessTimer); if (budgetTimer) clearTimeout(budgetTimer); if (killTimer) clearTimeout(killTimer); healthRunner?.stop(); if (child?.stdin && !child.stdin.destroyed) child.stdin.end(); livenessTimer = null; budgetTimer = null; killTimer = null; };
    const finish = (value) => { if (settled) return; settled = true; cleanup(); resolve(value); };
    const snapshot = () => ({ stdout: redact(stdout, plan.redact), stderr: redact(stderr, plan.redact), duration_ms: Date.now() - started, last_progress_at_ms: lastProgressMs, progress_events: progressEvents, retry_count: retryCount });
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
      onStart?.(child.pid); observeProcessLiveness();
      livenessTimer = setInterval(observeProcessLiveness, livenessIntervalMs); livenessTimer.unref();
      if (maxWallClockMs !== null) { budgetTimer = setTimeout(() => claimFailure("BUDGET_EXHAUSTED", `provider exceeded the explicit ${maxWallClockMs}ms wall-clock budget`), maxWallClockMs); budgetTimer.unref(); }
      const healthProbe = probeSession ?? plan.probeSession;
      healthRunner = createHealthRunner({ intervalMs: healthCheckIntervalMs, probeDeadlineMs, isCancelled, validateCompleted, probeSession: healthProbe ? (ctx) => healthProbe({ ...ctx, pid: child.pid, cwd: plan.cwd }) : null, onDecision: (decision) => {
        if (decision.status === "completed") { claimCompleted(decision); return; }
        claimFailure(decision.error.code, decision.error.message);
      } }); healthRunner.start();
      child.stdin.once("error", (error) => claimFailure("PROCESS_STDIN_FAILED", `provider stdin failed: ${error.message}`));
      if (plan.input !== null) { if (plan.keepStdinOpen === true) child.stdin.write(plan.input); else child.stdin.end(plan.input); }
      else if (plan.keepStdinOpen !== true) child.stdin.end();
    });
    child.once("error", (error) => { const value = snapshot(); finish({ ok: false, error: { code: "PROCESS_START_FAILED", message: error.message }, ...value }); });
    const terminateForOverflow = () => { claimFailure("OUTPUT_TOO_LARGE", `provider output exceeded ${maxOutputBytes} bytes`); };
    const observeLine = (name, line) => {
      const observation = plan.observeLine?.(name, line) ?? {};
      retryCount += Number.isSafeInteger(observation.retry_count) ? observation.retry_count : 0;
      if (observation.liveness === true) recordLiveness();
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
      const value = chunk.toString(); bytes += Buffer.byteLength(value); if (!overflow) { if (name === "stdout") stdout += value; else stderr += value; }
      onActivity?.();
      lineBuffers[name] += value;
      const complete = lineBuffers[name].split(/\r?\n/); lineBuffers[name] = complete.pop();
      for (const line of complete) observeLine(name, line);
      if (bytes > maxOutputBytes && !overflow) { overflow = true; terminateForOverflow(); }
    };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.once("close", (code, signal) => {
      for (const [name, line] of Object.entries(lineBuffers)) if (line) observeLine(name, line);
      const value = snapshot();
      if (terminalClaim?.kind === "failed") return finish({ ok: false, error: terminalClaim.error, ...value });
      if (terminalClaim?.kind === "completed") return finish({ ok: true, ...value, stdout: terminalClaim.harvest.raw.stdout, stderr: terminalClaim.harvest.raw.stderr, health_harvested: true });
      if (code === 0) return finish({ ok: true, ...value });
      finish({ ok: false, error: { code: failureCode(`${value.stdout}\n${value.stderr}`), message: `provider process exited with ${signal ?? code}` }, ...value });
    });
  });
}
