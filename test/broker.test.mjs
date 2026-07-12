import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Broker } from "../lib/broker.mjs";
import { validateConfig } from "../lib/config.mjs";
import { cleanup } from "../lib/runtime.mjs";

const fake = path.resolve("test/fake-cli.mjs");
const slow = path.resolve("test/slow-cli.mjs");
const silent = path.resolve("test/silent-cli.mjs");
const stream = path.resolve("test/stream-cli.mjs");
function config(root, tiers = [["claude-code", "kimi", "codex", "opencode"]]) {
  return validateConfig({ version: 4, runtime: { root, ttl_hours: 24, max_prompt_bytes: 10000, max_output_bytes: 100000, liveness_interval_ms: 5, idle_timeout_ms: 0, max_duration_ms: 0 }, tiers, providers: Object.fromEntries(["claude-code", "kimi", "codex", "opencode"].map((id) => [id, { enabled: true, command: fake, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [] }])) });
}
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-v4-test-")); }

test("runtime timeout configuration permits zero and rejects negatives", () => {
  const value = config(temp(), [["kimi"]]);
  assert.equal(validateConfig(value).runtime.idle_timeout_ms, 0);
  value.runtime.max_duration_ms = -1;
  assert.throws(() => validateConfig(value), /non-negative integer/);
});

test("runs all eligible providers in a tier and excludes the host", async () => {
  const broker = new Broker(config(temp())); const result = await broker.run({ version: 4, host_provider: "claude-code", prompt: "review", continuation: null });
  assert.equal(result.providers.find((item) => item.provider === "claude-code").error.code, "SAME_SOURCE");
  for (const id of ["kimi", "codex", "opencode"]) assert.equal(result.providers.find((item) => item.provider === id).status, "completed");
  assert.equal(result.round, 1); assert.equal(result.selected_tier, 0);
});

test("continuation uses only each provider's own native session", async () => {
  const broker = new Broker(config(temp(), [["kimi", "codex"]])); const first = await broker.run({ version: 4, host_provider: "claude-code", prompt: "one", continuation: null });
  const second = await broker.run({ version: 4, host_provider: "claude-code", prompt: "two", continuation: { runtime_id: first.runtime_id } });
  assert.equal(second.round, 2); assert.equal(second.selected_tier, null); assert.deepEqual(second.providers.map((item) => item.provider).sort(), ["codex", "kimi"]); assert.ok(second.providers.every((item) => item.status === "completed"));
});

test("falls through only after an entire tier has no success", async () => {
  const root = temp(); const value = config(root, [["claude-code"], ["kimi"]]); value.providers["claude-code"].command = "/does/not/exist";
  const result = await new Broker(value).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  assert.equal(result.selected_tier, 1); assert.equal(result.providers[0].status, "failed"); assert.equal(result.providers[1].provider, "kimi"); assert.equal(result.providers[1].status, "completed");
});

test("reports missing environment authentication without running the provider", async () => {
  const value = config(temp(), [["kimi"]]); value.providers.kimi.auth = { type: "env", env: ["THIRD_REVIEW_TEST_MISSING_KEY"] };
  const result = await new Broker(value).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  assert.equal(result.providers[0].error.code, "AUTH_ENV_MISSING");
});

test("a changed config makes only that continuation provider fail", async () => {
  const root = temp(); const first = await new Broker(config(root, [["kimi", "codex"]])).run({ version: 4, host_provider: "claude-code", prompt: "one", continuation: null });
  const changed = config(root, [["kimi"]]); delete changed.providers.codex;
  const result = await new Broker(changed).run({ version: 4, host_provider: "claude-code", prompt: "two", continuation: { runtime_id: first.runtime_id } });
  assert.equal(result.providers.find((item) => item.provider === "kimi").status, "completed");
  assert.equal(result.providers.find((item) => item.provider === "codex").error.code, "PROVIDER_NOT_CONFIGURED");
});

test("cleanup removes expired inactive state", () => {
  const root = temp(); const old = path.join(root, "old"); fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, "state.json"), JSON.stringify({ providers: {}, expires_at_ms: 0 }));
  assert.deepEqual(cleanup(root, 24), ["old"]); assert.equal(fs.existsSync(old), false);
});

test("cancel persists an independent cancellation marker", async () => {
  const root = temp(); const value = config(root, [["kimi"]]); value.providers.kimi.command = slow;
  const broker = new Broker(value); const running = broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const runtime_id = fs.readdirSync(root).find((name) => /^[0-9a-f-]{36}$/i.test(name));
  assert.deepEqual(broker.cancel(runtime_id, "kimi"), { cancelled: true });
  const result = await running;
  assert.equal(result.providers[0].status, "cancelled"); assert.equal(result.providers[0].error.code, "CANCELLED");
  const settled = broker.status(runtime_id).providers.kimi.heartbeat_at_ms;
  assert.equal(typeof settled, "number");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(broker.status(runtime_id).providers.kimi.heartbeat_at_ms, settled);
});

test("runtime keeps liveness and output activity as separate timestamps", async () => {
  const root = temp(); const value = config(root, [["opencode"]]); value.providers.opencode.command = silent;
  const broker = new Broker(value); const running = broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const runtime_id = fs.readdirSync(root).find((name) => /^[0-9a-f-]{36}$/i.test(name)); const first = broker.status(runtime_id).providers.opencode;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = broker.status(runtime_id).providers.opencode;
  assert.ok(second.heartbeat_at_ms > first.heartbeat_at_ms);
  assert.equal(second.last_activity_at_ms, first.last_activity_at_ms);
  await running;
});

test("broker preserves IDLE_TIMEOUT and PROCESS_TIMEOUT", async () => {
  const idle = config(temp(), [["opencode"]]); idle.providers.opencode.command = slow; idle.runtime.idle_timeout_ms = 30;
  const idleResult = await new Broker(idle).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  assert.equal(idleResult.providers[0].error.code, "IDLE_TIMEOUT");
  const duration = config(temp(), [["opencode"]]); duration.providers.opencode.command = slow; duration.runtime.max_duration_ms = 30;
  const durationResult = await new Broker(duration).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  assert.equal(durationResult.providers[0].error.code, "PROCESS_TIMEOUT");
});

test("broker updates last activity for stream output", async () => {
  const root = temp(); const value = config(root, [["opencode"]]); value.providers.opencode.command = stream;
  const broker = new Broker(value); const running = broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  await new Promise((resolve) => setTimeout(resolve, 35));
  const runtime_id = fs.readdirSync(root).find((name) => /^[0-9a-f-]{36}$/i.test(name)); const state = broker.status(runtime_id).providers.opencode;
  assert.ok(state.last_activity_at_ms >= state.started_at_ms);
  await running;
});
