import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execute } from "../lib/process.mjs";
import { terminateProcess } from "../lib/runtime.mjs";

const silent = path.resolve("test/silent-cli.mjs");
const stream = path.resolve("test/stream-cli.mjs");
const fail = path.resolve("test/fail-cli.mjs");
const slow = path.resolve("test/slow-cli.mjs");
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

test("silent process is terminated with its explicit timeout code", async () => {
  const idle = await execute(plan(slow), { maxOutputBytes: 4096, idleTimeoutMs: 30, livenessIntervalMs: 5 });
  assert.equal(idle.ok, false);
  assert.equal(idle.error.code, "IDLE_TIMEOUT");
  const duration = await execute(plan(slow), { maxOutputBytes: 4096, maxDurationMs: 30, livenessIntervalMs: 5 });
  assert.equal(duration.ok, false);
  assert.equal(duration.error.code, "PROCESS_TIMEOUT");
  const simultaneous = await execute(plan(slow), { maxOutputBytes: 4096, idleTimeoutMs: 30, maxDurationMs: 30, livenessIntervalMs: 5 });
  assert.equal(simultaneous.ok, false);
  assert.equal(simultaneous.error.code, "PROCESS_TIMEOUT");
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
  const running = execute(plan(slow), { maxOutputBytes: 4096, livenessIntervalMs: 5, onStart: (value) => { pid = value; }, onLiveness: () => liveness.push(Date.now()) });
  while (pid === null || liveness.length < 2) await delay(5);
  assert.equal(terminateProcess(pid), true);
  const result = await running;
  assert.equal(result.ok, false);
  const settled = liveness.length;
  await delay(25);
  assert.equal(liveness.length, settled);
});
