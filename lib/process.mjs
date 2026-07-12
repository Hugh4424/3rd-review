import { spawn } from "node:child_process";
import { failureCode } from "./adapters/index.mjs";
import { terminateProcess } from "./runtime.mjs";

function redact(text, values) { let result = text; for (const value of values) if (value) result = result.split(value).join("[REDACTED]"); return result; }

export function execute(plan, { maxOutputBytes, onStart, onActivity }) {
  return new Promise((resolve) => {
    const started = Date.now(); let child; let stdout = ""; let stderr = ""; let bytes = 0; let overflow = false;
    try { child = spawn(plan.command, plan.argv, { cwd: plan.cwd, env: plan.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }); }
    catch (error) { resolve({ ok: false, error: { code: "PROCESS_START_FAILED", message: error.message }, duration_ms: Date.now() - started, stdout: "", stderr: "" }); return; }
    child.once("spawn", () => { onStart?.(child.pid); if (plan.input !== null) child.stdin.end(plan.input); else child.stdin.end(); });
    child.once("error", (error) => resolve({ ok: false, error: { code: "PROCESS_START_FAILED", message: error.message }, duration_ms: Date.now() - started, stdout: "", stderr: "" }));
    const terminate = () => {
      terminateProcess(child.pid, "SIGTERM");
      // This is not a model deadline: it runs only after an explicit output
      // limit has been crossed. It prevents an ignored SIGTERM leaking a group.
      setTimeout(() => { terminateProcess(child.pid, "SIGKILL"); }, 5_000).unref();
    };
    const collect = (name) => (chunk) => { const value = chunk.toString(); bytes += Buffer.byteLength(value); if (!overflow) { if (name === "stdout") stdout += value; else stderr += value; } onActivity?.(); if (bytes > maxOutputBytes && !overflow) { overflow = true; terminate(); } };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.once("close", (code, signal) => {
      stdout = redact(stdout, plan.redact); stderr = redact(stderr, plan.redact); const duration_ms = Date.now() - started;
      if (overflow) return resolve({ ok: false, error: { code: "OUTPUT_TOO_LARGE", message: `provider output exceeded ${maxOutputBytes} bytes` }, duration_ms, stdout, stderr });
      if (code === 0) return resolve({ ok: true, duration_ms, stdout, stderr });
      resolve({ ok: false, error: { code: failureCode(`${stdout}\n${stderr}`), message: `provider process exited with ${signal ?? code}` }, duration_ms, stdout, stderr });
    });
  });
}
