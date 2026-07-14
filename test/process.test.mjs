import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execute } from "../lib/process.mjs";
import { jsonProgress } from "../lib/adapters/shared.mjs";
import { terminateProcess } from "../lib/runtime.mjs";

const silent = path.resolve("test/silent-cli.mjs");
const stream = path.resolve("test/stream-cli.mjs");
const fail = path.resolve("test/fail-cli.mjs");
const slow = path.resolve("test/slow-cli.mjs");
const duplicate = path.resolve("test/duplicate-progress-cli.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function plan(command, env = {}) { return { command, argv: [], cwd: fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-process-test-")), input: null, env: { ...process.env, ...env }, redact: [] }; }

test("silent live process emits liveness without activity", async () => {
  const liveness = []; const activity = [];
  const result = await execute(plan(silent), { maxOutputBytes: 4096, livenessIntervalMs: 10, onLiveness: () => liveness.push(Date.now()), onActivity: () => activity.push(Date.now()) });
  assert.equal(result.ok, true);
  assert.ok(liveness.length >= 3);
  assert.deepEqual(activity, []);
  const settled = liveness.length;
  await delay(35);
  assert.equal(liveness.length, settled);
});

test("deprecated timeout options have no runner semantics", async () => {
  const active = await execute(plan(stream), { maxOutputBytes: 4096, idleTimeoutMs: 30, livenessIntervalMs: 5, livenessCheckpointMs: 15 });
  assert.equal(active.ok, true);
  const silentLive = await execute(plan(silent, { THIRD_REVIEW_TEST_DURATION_MS: "80" }), { maxOutputBytes: 4096, idleTimeoutMs: 30, livenessIntervalMs: 5, livenessCheckpointMs: 15 });
  assert.equal(silentLive.ok, true);
});

test("PID liveness is diagnostic and cannot clear unverifiable health", async () => {
  const liveness = []; const result = await execute(plan(silent, { THIRD_REVIEW_TEST_DURATION_MS: "80" }), { maxOutputBytes: 4096, healthCheckIntervalMs: 10, livenessIntervalMs: 5, onLiveness: (value) => liveness.push(value) });
  assert.ok(liveness.length > 0); assert.equal(result.ok, false); assert.equal(result.error.code, "HEALTH_UNVERIFIABLE");
});

test("sequenced heartbeat events update liveness but never progress", async () => {
  const liveness = [];
  const result = await execute({ ...plan(process.execPath), argv: [duplicate], observeLine: jsonProgress }, { maxOutputBytes: 4096, idleTimeoutMs: 100, livenessIntervalMs: 1_000, onLiveness: (value) => liveness.push(value) });
  assert.equal(result.ok, true); assert.equal(result.progress_events, 0); assert.equal(result.last_progress_at_ms, null); assert.ok(liveness.length >= 4);
});

test("dead health terminates immediately without waiting for PID exit", async () => {
  const started = Date.now(); const result = await execute({ ...plan(silent, { THIRD_REVIEW_TEST_DURATION_MS: "80" }), probeSession: async () => ({ status: "dead", session_id: null, cursor: null, raw: null, error: { code: "PROCESS_DEAD" }, evidence: "dead" }) }, { maxOutputBytes: 4096, healthCheckIntervalMs: 10 });
  assert.equal(result.ok, false); assert.equal(result.error.code, "PROCESS_DEAD"); assert.ok(Date.now() - started < 250);
});

test("an injected health probe explicitly overrides the adapter plan probe", async () => {
  let planCalls = 0; let injectedCalls = 0;
  const result = await execute({ ...plan(silent, { THIRD_REVIEW_TEST_DURATION_MS: "80" }), probeSession: async () => { planCalls += 1; return { status: "busy", session_id: null, cursor: null, raw: null, error: null, evidence: "adapter" }; } }, { maxOutputBytes: 4096, healthCheckIntervalMs: 10, probeSession: async () => { injectedCalls += 1; return { status: "dead", session_id: null, cursor: null, raw: null, error: { code: "PROCESS_DEAD" }, evidence: "injected" }; } });
  assert.equal(result.ok, false); assert.equal(result.error.code, "PROCESS_DEAD"); assert.equal(injectedCalls, 1); assert.equal(planCalls, 0);
});

test("PID liveness cannot keep an unchanged busy health session alive", async () => {
  const liveness = []; const result = await execute({ ...plan(silent, { THIRD_REVIEW_TEST_DURATION_MS: "200" }), probeSession: async () => ({ status: "busy", session_id: "s", cursor: "same", raw: null, error: null, evidence: "unchanged" }) }, { maxOutputBytes: 4096, healthCheckIntervalMs: 10, livenessIntervalMs: 2, onLiveness: (value) => liveness.push(value) });
  assert.ok(liveness.length > 5); assert.equal(result.ok, false); assert.equal(result.error.code, "PROCESS_STALLED");
});

test("completed health raw is harvested and a hanging wrapper is internally terminated", async () => {
  const raw = `${JSON.stringify({ type: "session.completed", session_id: "health-session", text: "health opinion" })}\n`;
  const result = await execute({ ...plan(silent, { THIRD_REVIEW_TEST_DURATION_MS: "80" }), probeSession: async () => ({ status: "completed", session_id: "health-session", cursor: "done", raw: { stdout: raw, stderr: "" }, error: null, evidence: "terminal" }) }, { maxOutputBytes: 4096, healthCheckIntervalMs: 10, validateCompleted: (value) => value.stdout === raw });
  assert.equal(result.ok, true); assert.equal(result.stdout, raw); assert.equal(result.health_harvested, true); assert.equal(result.error, undefined);
});

test("stream fallback fails closed after two rounds without a valid event", async () => {
  const result = await execute(plan(silent, { THIRD_REVIEW_TEST_DURATION_MS: "80" }), { maxOutputBytes: 4096, healthCheckIntervalMs: 10 });
  assert.equal(result.ok, false); assert.equal(result.error.code, "HEALTH_UNVERIFIABLE");
});

test("stream output reports activity and monitors stop after close or error", async () => {
  const activity = []; const liveness = [];
  const streamed = await execute(plan(stream), { maxOutputBytes: 4096, idleTimeoutMs: 1000, livenessIntervalMs: 5, onLiveness: () => liveness.push(Date.now()), onActivity: () => activity.push(Date.now()) });
  assert.equal(streamed.ok, true);
  assert.ok(activity.length >= 3);
  const afterClose = liveness.length;
  await delay(25);
  assert.equal(liveness.length, afterClose);

  const failedLiveness = [];
  const failed = await execute(plan(fail), { maxOutputBytes: 4096, livenessIntervalMs: 5, onLiveness: () => failedLiveness.push(Date.now()) });
  assert.equal(failed.ok, false);
  const afterError = failedLiveness.length;
  await delay(25);
  assert.equal(failedLiveness.length, afterError);
});

test("external termination stops liveness monitoring", async () => {
  let pid = null; const liveness = [];
  const started = Date.now(); const running = execute(plan(slow), { maxOutputBytes: 4096, idleTimeoutMs: 1_000, livenessIntervalMs: 5, onStart: (value) => { pid = value; }, onLiveness: () => liveness.push(Date.now()) });
  while (pid === null || liveness.length < 2) await delay(5);
  assert.equal(terminateProcess(pid), true);
  const result = await running;
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 500);
  const settled = liveness.length;
  await delay(25);
  assert.equal(liveness.length, settled);
});

test("large stdin write to an immediately exiting provider is a structured failure", async () => {
  const result = await execute({
    command: process.execPath,
    argv: ["-e", "process.exit(0)"],
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-process-test-")),
    input: "x".repeat(1024 * 1024),
    env: process.env,
    redact: [],
  }, { maxOutputBytes: 4096 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROCESS_STDIN_FAILED");
});
