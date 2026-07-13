import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isAlive, readRuntime } from "../lib/runtime.mjs";

const slow = path.resolve("test/slow-cli.mjs");
const slowSuccess = path.resolve("test/slow-success-cli.mjs");
const cli = path.resolve("scripts/3rd-review.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-cli-lifecycle-")); }
async function waitForRuntime(root) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runtime = fs.readdirSync(root).find((name) => /^[0-9a-f-]{36}$/i.test(name));
    if (runtime) {
      try { const state = readRuntime(root, runtime); if (state.providers.kimi?.status === "running") return { runtime, state }; } catch { /* runtime creation publishes state immediately after its directory */ }
    }
    await delay(10);
  }
  throw new Error("provider did not enter running state");
}
function collect(command, args) {
  return new Promise((resolve) => { const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.once("close", (code) => resolve({ code, stdout, stderr })); });
}

test("SIGTERM to broker cancels its provider tree with workflow_shutdown provenance", async () => {
  const root = temp(); const config = path.join(root, "config.json"); const request = path.join(root, "request.json");
  fs.writeFileSync(config, JSON.stringify({ version: 4, runtime: { root, ttl_hours: 24, max_prompt_bytes: 10_000, max_output_bytes: 100_000, liveness_interval_ms: 5, idle_timeout_ms: 0, max_duration_ms: 10_000, orphan_timeout_ms: 100 }, tiers: [["kimi"]], providers: { kimi: { enabled: true, command: slow, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [] } } }));
  fs.writeFileSync(request, JSON.stringify({ version: 4, host_provider: "codex", prompt: "review", continuation: null }));
  const broker = spawn(process.execPath, [cli, "run", `--config=${config}`, `--request=${request}`], { stdio: "ignore" });
  const { runtime, state: running } = await waitForRuntime(root);
  assert.equal(broker.kill("SIGTERM"), true);
  await new Promise((resolve) => broker.once("close", resolve));
  const settled = readRuntime(root, runtime).providers.kimi;
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.error.code, "CANCELLED");
  assert.equal(settled.cancellation_source, "workflow_shutdown");
  await delay(30);
  assert.equal(isAlive(running.providers.kimi.pid), false);
});

test("concurrent continuation atomically claims a provider and preserves unique rounds", async () => {
  const root = temp(); const config = path.join(root, "config.json"); const firstRequest = path.join(root, "first.json"); const nextRequest = path.join(root, "next.json");
  fs.writeFileSync(config, JSON.stringify({ version: 4, runtime: { root, ttl_hours: 24, max_prompt_bytes: 10_000, max_output_bytes: 100_000, liveness_interval_ms: 5, idle_timeout_ms: 0, max_duration_ms: 10_000, orphan_timeout_ms: 100 }, tiers: [["kimi"]], providers: { kimi: { enabled: true, command: slowSuccess, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [] } } }));
  fs.writeFileSync(firstRequest, JSON.stringify({ version: 4, host_provider: "codex", prompt: "first", continuation: null }));
  const first = await collect(process.execPath, [cli, "run", `--config=${config}`, `--request=${firstRequest}`]); assert.equal(first.code, 0); const initial = JSON.parse(first.stdout); assert.equal(initial.providers[0].status, "completed");
  fs.writeFileSync(nextRequest, JSON.stringify({ version: 4, host_provider: "codex", prompt: "continue", continuation: { runtime_id: initial.runtime_id } }));
  const firstCall = collect(process.execPath, [cli, "run", `--config=${config}`, `--request=${nextRequest}`]); await delay(60); const calls = await Promise.all([firstCall, collect(process.execPath, [cli, "run", `--config=${config}`, `--request=${nextRequest}`])]); const results = calls.map((item) => { assert.equal(item.code, 0, item.stderr); return JSON.parse(item.stdout); });
  assert.deepEqual(results.map((item) => item.round).sort(), [2, 3]); assert.equal(readRuntime(root, initial.runtime_id).round, 3);
  const providers = results.map((item) => item.providers[0]); assert.equal(providers.filter((item) => item.status === "completed").length, 1); assert.equal(providers.filter((item) => item.error?.code === "PROVIDER_BUSY").length, 1);
});

test("a dead provider claim is reclaimed before continuation", async () => {
  const root = temp(); const config = path.join(root, "config.json"); const firstRequest = path.join(root, "first.json"); const nextRequest = path.join(root, "next.json");
  fs.writeFileSync(config, JSON.stringify({ version: 4, runtime: { root, max_duration_ms: 10_000, orphan_timeout_ms: 100 }, tiers: [["kimi"]], providers: { kimi: { command: slowSuccess, auth: { type: "native" } } } })); fs.writeFileSync(firstRequest, JSON.stringify({ version: 4, host_provider: "codex", prompt: "first", continuation: null }));
  const initial = JSON.parse((await collect(process.execPath, [cli, "run", `--config=${config}`, `--request=${firstRequest}`])).stdout); const claim = path.join(root, initial.runtime_id, ".claims", "kimi"); fs.mkdirSync(claim, { recursive: true }); fs.writeFileSync(path.join(claim, "owner.json"), JSON.stringify({ version: 1, token: "dead", pid: 999_999_999, created_at_ms: 1 }));
  fs.writeFileSync(nextRequest, JSON.stringify({ version: 4, host_provider: "codex", prompt: "continue", continuation: { runtime_id: initial.runtime_id } })); const result = JSON.parse((await collect(process.execPath, [cli, "run", `--config=${config}`, `--request=${nextRequest}`])).stdout);
  assert.equal(result.providers[0].status, "completed"); assert.equal(fs.existsSync(claim), false);
});
