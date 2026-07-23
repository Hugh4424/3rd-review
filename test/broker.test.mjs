import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { Broker } from "../lib/broker.mjs";
import { validateConfig } from "../lib/config.mjs";
import { cleanup, createRuntime, currentOwnerIdentity, ensureRuntimeGuardian, isAlive, processIdentity, readRuntime, terminateProcess, updateRuntime } from "../lib/runtime.mjs";

const fake = path.resolve("test/fake-cli.mjs");
const slow = path.resolve("test/slow-cli.mjs");
const silent = path.resolve("test/silent-cli.mjs");
const stream = path.resolve("test/stream-cli.mjs");
const kimiRetry = path.resolve("test/kimi-retry-cli.mjs");
function config(root, tiers = [["claude-code", "kimi", "codex", "opencode"]]) {
  const ids = [...new Set(tiers.flat())];
  return validateConfig({ version: 4, runtime: { root, ttl_hours: 24, max_prompt_bytes: 10000, max_output_bytes: 100000, liveness_interval_ms: 5 }, tiers, providers: Object.fromEntries(ids.map((id) => [id, { enabled: true, command: fake, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [] }])) });
}
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-v4-test-")); }
async function eventually(check, timeoutMs = 3_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } assert.fail("condition did not become true"); }

test("legacy wall-clock budgets are ignored and legacy timer fields are rejected", () => {
  const value = config(temp(), [["kimi"]]);
  assert.equal(value.runtime.max_wall_clock_ms, null);
  value.runtime.max_wall_clock_ms = null; assert.equal(validateConfig(value).runtime.max_wall_clock_ms, null);
  for (const legacy of [900_000, 0, -1, 1.5, "1000"]) { value.runtime.max_wall_clock_ms = legacy; assert.equal(validateConfig(value).runtime.max_wall_clock_ms, null); }
  delete value.runtime.max_wall_clock_ms; value.runtime.idle_timeout_ms = 1; assert.throws(() => validateConfig(value), /no longer supported/);
  delete value.runtime.idle_timeout_ms; value.runtime.max_duration_ms = 1; assert.throws(() => validateConfig(value), /no longer supported/);
});

test("config requires every provider to appear exactly once in tiers", () => {
  const value = config(temp(), [["kimi", "codex"]]);
  value.providers.opencode = { ...value.providers.kimi, id: "opencode" };
  assert.throws(() => validateConfig(value), /provider opencode must appear in tiers/);
  value.tiers = [["kimi", "codex"], ["kimi", "opencode"]];
  assert.throws(() => validateConfig(value), /provider kimi appears more than once/);
});

test("default route runs one heterologous provider", async () => {
  const broker = new Broker(config(temp())); const result = await broker.run({ version: 4, host_provider: "claude-code", prompt: "review", continuation: null });
  assert.deepEqual(result.providers.map((item) => item.provider), ["kimi"]); assert.equal(result.providers[0].status, "completed");
  assert.equal(result.outcome, "completed"); assert.equal(result.round, 1); assert.equal(result.selected_tier, 0);
});

test("continuation uses only each provider's own native session", async () => {
  const broker = new Broker(config(temp(), [["kimi", "codex"]])); const first = await broker.run({ version: 4, host_provider: "claude-code", prompt: "one", continuation: null });
  const second = await broker.run({ version: 4, host_provider: "claude-code", prompt: "two", continuation: { runtime_id: first.runtime_id } });
  assert.equal(second.round, 2); assert.equal(second.selected_tier, null); assert.deepEqual(second.providers.map((item) => item.provider), ["kimi"]); assert.ok(second.providers.every((item) => item.status === "completed"));
});

test("falls through only after an entire tier has no success", async () => {
  const root = temp(); const value = config(root, [["claude-code"], ["kimi"]]); value.providers["claude-code"].command = "/does/not/exist";
  const result = await new Broker(value).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  assert.equal(result.selected_tier, 1); assert.equal(result.providers[0].status, "failed"); assert.equal(result.providers[1].provider, "kimi"); assert.equal(result.providers[1].status, "completed");
});

test("reports missing environment authentication without running the provider", async () => {
  const value = config(temp(), [["kimi"]]); value.providers.kimi.auth = { type: "env", env: ["THIRD_REVIEW_TEST_MISSING_KEY"] };
  const result = await new Broker(value).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  assert.equal(result.providers[0].error.code, "AUTH_ENV_MISSING"); assert.equal(result.providers.length, 1); assert.equal(result.outcome, "invalid_output");
});

test("continuation keeps the single provider selected initially", async () => {
  const root = temp(); const first = await new Broker(config(root, [["kimi", "codex"]])).run({ version: 4, host_provider: "claude-code", prompt: "one", continuation: null });
  const changed = config(root, [["kimi"]]); delete changed.providers.codex;
  const result = await new Broker(changed).run({ version: 4, host_provider: "claude-code", prompt: "two", continuation: { runtime_id: first.runtime_id } });
  assert.deepEqual(result.providers.map((item) => item.provider), ["kimi"]); assert.equal(result.providers[0].status, "completed");
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
  const root = temp(); const value = config(root, [["kimi", "opencode"]]);
  const result = await new Broker(value).run({ version: 4, host_provider: "codex", prompt: "UNIQUE_REVIEW_PACKET", continuation: null });
  const runtime = path.join(root, result.runtime_id, "workspace");
  const kimiInput = fs.readFileSync(path.join(runtime, "kimi", "review-input.md"), "utf8"); assert.match(kimiInput, /^Review only the supplied instruction/); assert.match(kimiInput, /UNIQUE_REVIEW_PACKET$/);
  assert.equal(fs.existsSync(path.join(runtime, "opencode", "review-input.md")), false);
  assert.equal(fs.existsSync(path.join(runtime, "review-input.md")), false);
});

test("cleanup reaps an orphaned broker process and records ORPHANED_BROKER", async () => {
  const root = temp(); const runtime = createRuntime(root, 24, "codex");
  const orphan = spawn(process.execPath, [slow], { detached: true, stdio: "ignore" }); orphan.unref();
  updateRuntime(root, runtime.runtime_id, (state) => ({ ...state, owner: { ...currentOwnerIdentity(), pid: 999_999_999, started_at_ms: 1 }, providers: { kimi: { provider: "kimi", status: "running", pid: orphan.pid, worker: processIdentity(orphan.pid), started_at_ms: 1, process_alive_at_ms: 1, last_progress_at_ms: 1 } } }));
  cleanup(root, 24);
  const state = readRuntime(root, runtime.runtime_id);
  assert.equal(state.providers.kimi.status, "failed");
  assert.equal(state.providers.kimi.error.code, "ORPHANED_BROKER");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(isAlive(orphan.pid), false);
});

test("cleanup does not reap an active provider only because its heartbeat is stale", async () => {
  const root = temp(); const runtime = createRuntime(root, 24, "codex");
  const active = spawn(process.execPath, [slow], { detached: true, stdio: "ignore" }); active.unref();
  updateRuntime(root, runtime.runtime_id, (state) => ({ ...state, owner: { pid: process.pid, started_at_ms: 1 }, providers: { kimi: { provider: "kimi", status: "running", pid: active.pid, started_at_ms: 1, process_alive_at_ms: 1, last_progress_at_ms: 1 } } }));
  cleanup(root, 24);
  assert.equal(readRuntime(root, runtime.runtime_id).providers.kimi.status, "running");
  assert.equal(isAlive(active.pid), true);
  terminateProcess(active.pid);
});

test("detached guardian reaps only after its owner identity is confirmed dead", async () => {
  const root = temp(); const runtime = createRuntime(root, 24, "codex");
  const active = spawn(process.execPath, [slow], { detached: true, stdio: "ignore" }); active.unref();
  updateRuntime(root, runtime.runtime_id, (state) => ({ ...state, owner: { ...currentOwnerIdentity(), pid: 999_999_999, started_at_ms: 1 }, providers: { kimi: { provider: "kimi", status: "running", pid: active.pid, worker: processIdentity(active.pid), started_at_ms: 1, process_alive_at_ms: 1, last_progress_at_ms: 1 } } }));
  assert.equal(ensureRuntimeGuardian(root, runtime.runtime_id), true);
  await eventually(() => readRuntime(root, runtime.runtime_id).providers.kimi.status === "failed");
  assert.equal(readRuntime(root, runtime.runtime_id).providers.kimi.error.code, "ORPHANED_BROKER");
  await eventually(() => !isAlive(active.pid));
});

test("detached guardian stays active until a later owner death", async () => {
  const root = temp(); const runtime = createRuntime(root, 24, "codex");
  const active = spawn(process.execPath, [slow], { detached: true, stdio: "ignore" }); active.unref();
  updateRuntime(root, runtime.runtime_id, (state) => ({ ...state, owner: { ...currentOwnerIdentity(), started_at_ms: 1 }, providers: { kimi: { provider: "kimi", status: "running", pid: active.pid, worker: processIdentity(active.pid), started_at_ms: 1, process_alive_at_ms: 1, last_progress_at_ms: 1 } } }));
  assert.equal(ensureRuntimeGuardian(root, runtime.runtime_id), true);
  await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(readRuntime(root, runtime.runtime_id).providers.kimi.status, "running");
  updateRuntime(root, runtime.runtime_id, (state) => ({ ...state, owner: { ...currentOwnerIdentity(), pid: 999_999_999, started_at_ms: 1 } }));
  await eventually(() => readRuntime(root, runtime.runtime_id).providers.kimi.status === "failed");
  await eventually(() => !isAlive(active.pid));
});

test("guardian records a reused worker identity as orphaned without signalling that PID", async () => {
  const root = temp(); const runtime = createRuntime(root, 24, "codex");
  const active = spawn(process.execPath, [slow], { detached: true, stdio: "ignore" }); active.unref();
  updateRuntime(root, runtime.runtime_id, (state) => ({ ...state, owner: { ...currentOwnerIdentity(), pid: 999_999_999, started_at_ms: 1 }, providers: { kimi: { provider: "kimi", status: "running", pid: active.pid, worker: { ...processIdentity(active.pid), started: "forged-worker-start" }, started_at_ms: 1, process_alive_at_ms: 1, last_progress_at_ms: 1 } } }));
  assert.equal(ensureRuntimeGuardian(root, runtime.runtime_id), true);
  await eventually(() => readRuntime(root, runtime.runtime_id).providers.kimi.status === "failed");
  assert.equal(readRuntime(root, runtime.runtime_id).providers.kimi.error.code, "ORPHANED_BROKER");
  assert.equal(isAlive(active.pid), true);
  terminateProcess(active.pid);
});

test("a reused worker PID is never signalled by cleanup or cancel", async () => {
  const root = temp(); const runtime = createRuntime(root, 24, "codex");
  const active = spawn(process.execPath, [slow], { detached: true, stdio: "ignore" }); active.unref();
  updateRuntime(root, runtime.runtime_id, (state) => ({ ...state, owner: { ...currentOwnerIdentity(), pid: 999_999_999, started_at_ms: 1 }, providers: { kimi: { provider: "kimi", status: "running", pid: active.pid, worker: { ...processIdentity(active.pid), started: "forged-worker-start" }, started_at_ms: 1, process_alive_at_ms: 1, last_progress_at_ms: 1 } } }));
  cleanup(root, 24); assert.equal(isAlive(active.pid), true);
  const broker = new Broker(config(root, [["kimi"]]));
  assert.equal(readRuntime(root, runtime.runtime_id).providers.kimi.error.code, "ORPHANED_BROKER");
  assert.deepEqual(broker.cancel(runtime.runtime_id, "kimi"), { cancelled: false, reason: "NOT_ACTIVE" });
  const continuation = await broker.run({ version: 4, host_provider: "codex", prompt: "follow up", continuation: { runtime_id: runtime.runtime_id } });
  assert.notEqual(continuation.providers[0].error.code, "PROVIDER_BUSY");
  terminateProcess(active.pid);
});

test("owner PID reuse is distinguished by its recorded process start identity", async () => {
  const root = temp(); const runtime = createRuntime(root, 24, "codex");
  const active = spawn(process.execPath, [slow], { detached: true, stdio: "ignore" }); active.unref();
  const reused = { ...currentOwnerIdentity(), started: "forged-process-start", started_at_ms: 1 };
  updateRuntime(root, runtime.runtime_id, (state) => ({ ...state, owner: reused, providers: { kimi: { provider: "kimi", status: "running", pid: active.pid, worker: processIdentity(active.pid), started_at_ms: 1, process_alive_at_ms: 1, last_progress_at_ms: 1 } } }));
  cleanup(root, 24);
  assert.equal(readRuntime(root, runtime.runtime_id).providers.kimi.error.code, "ORPHANED_BROKER");
  await eventually(() => !isAlive(active.pid));
});

test("broker updates last progress for parsed stream output", async () => {
  const root = temp(); const value = config(root, [["opencode"]]); value.providers.opencode.command = stream;
  const broker = new Broker(value); const result = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  const state = broker.status(result.runtime_id).providers.opencode;
  assert.ok(state.last_progress_at_ms >= state.started_at_ms); assert.ok(state.progress_events > 0);
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

test("a dead health probe does not terminate an otherwise live Kimi process", async () => {
  const root = temp(); const value = config(root, [["kimi"]]); value.providers.kimi.command = slow;
  const broker = new Broker(value, { healthCheckIntervalMs: 10, probeSession: async () => ({ status: "dead", session_id: null, cursor: null, raw: null, error: { code: "PROCESS_DEAD" }, evidence: "test probe" }) });
  const running = broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const runtimeId = fs.readdirSync(root).find((id) => /^[0-9a-f-]{36}$/i.test(id)); const state = readRuntime(root, runtimeId).providers.kimi;
  assert.equal(state.status, "running"); assert.equal(isAlive(state.pid), true);
  broker.cancel(runtimeId, "kimi"); const result = await running;
  assert.equal(result.providers[0].status, "cancelled");
});
