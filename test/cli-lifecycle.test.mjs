import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isAlive, readRuntime } from "../lib/runtime.mjs";

const slow = path.resolve("test/slow-cli.mjs");
const cli = path.resolve("scripts/3rd-review.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-cli-lifecycle-")); }
async function waitForRuntime(root) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runtime = fs.readdirSync(root).find((name) => /^[0-9a-f-]{36}$/i.test(name));
    if (runtime) {
      const state = readRuntime(root, runtime);
      if (state.providers.kimi?.status === "running") return { runtime, state };
    }
    await delay(10);
  }
  throw new Error("provider did not enter running state");
}

test("SIGTERM to broker cancels its provider tree with broker_shutdown provenance", async () => {
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
  assert.equal(settled.cancellation_source, "broker_shutdown");
  await delay(30);
  assert.equal(isAlive(running.providers.kimi.pid), false);
});
