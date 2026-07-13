import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { Broker } from "../lib/broker.mjs";
import { validateConfig } from "../lib/config.mjs";
import { cleanup, createRuntime, isAlive, readRuntime, updateRuntime } from "../lib/runtime.mjs";

const fake = path.resolve("test/fake-cli.mjs");
const slow = path.resolve("test/slow-cli.mjs");
const silent = path.resolve("test/silent-cli.mjs");
const stream = path.resolve("test/stream-cli.mjs");
const kimiRetry = path.resolve("test/kimi-retry-cli.mjs");
function config(root, tiers = [["claude-code", "kimi", "codex", "opencode"]]) {
  return validateConfig({ version: 4, runtime: { root, ttl_hours: 24, max_prompt_bytes: 10000, max_output_bytes: 100000, liveness_interval_ms: 5, idle_timeout_ms: 0, max_duration_ms: 1_000 }, tiers, providers: Object.fromEntries(["claude-code", "kimi", "codex", "opencode"].map((id) => [id, { enabled: true, command: fake, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [] }])) });
}
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-v4-test-")); }

test("runtime timeout configuration rejects an unbounded production lifecycle", () => {
  const value = config(temp(), [["kimi"]]);
  value.runtime.max_duration_ms = 0;
  assert.throws(() => validateConfig(value), /cannot both be 0/);
  value.runtime.max_duration_ms = 360_000;
  assert.equal(validateConfig(value).runtime.max_duration_ms, 360_000);
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
  const settled = broker.status(runtime_id).providers.kimi.process_alive_at_ms;
  assert.equal(typeof settled, "number");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(broker.status(runtime_id).providers.kimi.process_alive_at_ms, settled);
});

test("runtime keeps process liveness and output progress as separate timestamps", async () => {
  const root = temp(); const value = config(root, [["opencode"]]); value.providers.opencode.command = silent;
  const broker = new Broker(value); const running = broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const runtime_id = fs.readdirSync(root).find((name) => /^[0-9a-f-]{36}$/i.test(name)); const first = broker.status(runtime_id).providers.opencode;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = broker.status(runtime_id).providers.opencode;
  assert.ok(second.process_alive_at_ms > first.process_alive_at_ms);
  assert.equal(second.last_progress_at_ms, first.last_progress_at_ms);
  await running;
});

test("providers receive isolated workspaces and independent review inputs", async () => {
  const root = temp(); const value = config(root, [["kimi", "opencode"]]); value.runtime.max_duration_ms = 360_000;
  const result = await new Broker(value).run({ version: 4, host_provider: "codex", prompt: "UNIQUE_REVIEW_PACKET", continuation: null });
  const runtime = path.join(root, result.runtime_id, "workspace");
  assert.equal(fs.readFileSync(path.join(runtime, "kimi", "review-input.md"), "utf8"), "UNIQUE_REVIEW_PACKET");
  assert.equal(fs.existsSync(path.join(runtime, "opencode", "review-input.md")), false);
  assert.equal(fs.existsSync(path.join(runtime, "review-input.md")), false);
});

test("cleanup reaps an orphaned broker process and records ORPHANED_BROKER", async () => {
  const root = temp(); const runtime = createRuntime(root, 24, "codex");
  const orphan = spawn(process.execPath, [slow], { detached: true, stdio: "ignore" }); orphan.unref();
  updateRuntime(root, runtime.runtime_id, (state) => ({ ...state, owner: { pid: 999_999_999, started_at_ms: 1 }, providers: { kimi: { provider: "kimi", status: "running", pid: orphan.pid, started_at_ms: 1, process_alive_at_ms: 1, last_progress_at_ms: 1 } } }));
  cleanup(root, 24);
  const state = readRuntime(root, runtime.runtime_id);
  assert.equal(state.providers.kimi.status, "failed");
  assert.equal(state.providers.kimi.error.code, "ORPHANED_BROKER");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(isAlive(orphan.pid), false);
});

test("broker preserves IDLE_TIMEOUT and PROCESS_TIMEOUT", async () => {
  const idle = config(temp(), [["opencode"]]); idle.providers.opencode.command = slow; idle.runtime.idle_timeout_ms = 30;
  const idleResult = await new Broker(idle).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  assert.equal(idleResult.providers[0].error.code, "IDLE_TIMEOUT");
  const duration = config(temp(), [["opencode"]]); duration.providers.opencode.command = slow; duration.runtime.max_duration_ms = 30;
  const durationResult = await new Broker(duration).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  assert.equal(durationResult.providers[0].error.code, "PROCESS_TIMEOUT");
});

test("broker updates last progress for parsed stream output", async () => {
  const root = temp(); const value = config(root, [["opencode"]]); value.providers.opencode.command = stream;
  const broker = new Broker(value); const running = broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  await new Promise((resolve) => setTimeout(resolve, 35));
  const runtime_id = fs.readdirSync(root).find((name) => /^[0-9a-f-]{36}$/i.test(name)); const state = broker.status(runtime_id).providers.opencode;
  assert.ok(state.last_progress_at_ms >= state.started_at_ms);
  await running;
});

test("Kimi records stream progress and APIEmptyResponseError retries", async () => {
  const root = temp(); const value = config(root, [["kimi"]]); value.providers.kimi.command = kimiRetry;
  const result = await new Broker(value).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  const item = result.providers[0];
  assert.equal(item.status, "completed");
  assert.equal(item.retry_count, 2);
  assert.equal(item.api_empty_response_count, 2);
  assert.ok(item.progress_events >= 2);
  assert.equal(typeof item.last_progress_at_ms, "number");
});

test("silent Kimi hits its hard duration limit and leaves no live process", async () => {
  const root = temp(); const value = config(root, [["kimi"]]); value.providers.kimi.command = slow; value.runtime.max_duration_ms = 30;
  const result = await new Broker(value).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  const item = result.providers[0]; const state = readRuntime(root, result.runtime_id).providers.kimi;
  assert.equal(item.status, "failed");
  assert.equal(item.error.code, "PROCESS_TIMEOUT");
  assert.equal(item.last_progress_at_ms, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(isAlive(state.pid), false);
});
