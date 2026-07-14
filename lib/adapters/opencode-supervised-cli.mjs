#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createOpenCodeProbe } from "./opencode.mjs";

const specification = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
let server = null; let client = null; let stopping = false;
const terminate = (child, signal = "SIGTERM") => { if (child?.pid && child.exitCode === null) try { child.kill(signal); } catch {} };
function cleanup(signal = "SIGTERM") { if (stopping) return; stopping = true; terminate(client, signal); terminate(server, signal); }
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { cleanup(signal); setTimeout(() => process.exit(128), 100).unref(); });

async function ready(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited before readiness (${child.exitCode})`);
    try { const response = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(250) }); if (response.ok && (await response.json()).healthy === true) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("OpenCode server did not become healthy");
}

try {
  server = spawn(specification.command, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(specification.port)], { env: process.env, cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
  let serverError = ""; server.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
  await ready(specification.url, server);
  client = spawn(specification.command, specification.clientArgv, { env: process.env, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  let sessionID = null; let lineBuffer = "";
  process.stdin.pipe(client.stdin); client.stdout.on("data", (chunk) => {
    const value = chunk.toString(); process.stdout.write(value); lineBuffer += value;
    const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop();
    for (const line of lines) try { const item = JSON.parse(line); sessionID ??= item.sessionID ?? item.session_id ?? null; } catch {}
  }); client.stderr.pipe(process.stderr);
  const code = await new Promise((resolve, reject) => { client.once("error", reject); client.once("close", (value) => resolve(value ?? 1)); });
  if (code === 0 && sessionID) {
    const terminal = await createOpenCodeProbe({ url: specification.url })({ session_id: sessionID, signal: AbortSignal.timeout(2_000) });
    if (terminal.status === "completed") process.stdout.write(terminal.raw.stdout);
  }
  cleanup(); process.exitCode = code;
} catch (error) {
  cleanup(); process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
