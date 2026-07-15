import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import opencode, { createOpenCodeProbe } from "../lib/adapters/opencode.mjs";
import { execute } from "../lib/process.mjs";

const provider = { id: "opencode", command: "opencode", model: null, effort: null, auth: { env: [] }, env: [] };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const healthFixture = path.resolve("test/opencode-health-fixture.mjs");
async function assertEventuallyUnavailable(url, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(url, { signal: AbortSignal.timeout(50) }); }
    catch { return; }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`OpenCode health server remained available: ${url}`);
}

test("OpenCode start and resume attach to one loopback server owned by the plan", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-provider-work-"));
  const first = opencode.start(provider, cwd, "review", "/tmp/runtime");
  assert.match(first.healthServer.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(first.clientArgv.includes("--attach"), true);
  assert.equal(first.clientArgv[first.clientArgv.indexOf("--attach") + 1], first.healthServer.url);
  assert.equal(first.clientArgv.includes("--session"), false);

  const resumed = opencode.resume(provider, cwd, "ses_keep", "delta", "/tmp/runtime");
  assert.equal(resumed.clientArgv[resumed.clientArgv.indexOf("--attach") + 1], resumed.healthServer.url);
  assert.equal(resumed.clientArgv[resumed.clientArgv.indexOf("--session") + 1], "ses_keep");
  assert.deepEqual(resumed.healthServer.bind, { hostname: "127.0.0.1", port: Number(new URL(resumed.healthServer.url).port) });
});

test("OpenCode probe binds status and message-part cursor to the requested session", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/session/status")) return response({ other: { type: "idle" }, ses_target: { type: "busy" } });
    return response([{ info: { id: "msg_1", sessionID: "ses_target", role: "assistant" }, parts: [{ id: "prt_2", type: "reasoning", text: "working" }] }]);
  };
  const probe = createOpenCodeProbe({ url: "http://127.0.0.1:43210", fetchImpl });
  const result = await probe({ session_id: "ses_target", cursor: null, signal: new AbortController().signal });
  assert.equal(result.status, "busy");
  assert.equal(result.session_id, "ses_target");
  assert.match(result.cursor, /msg_1.*prt_2/);
  assert.deepEqual(calls, ["http://127.0.0.1:43210/session/status", "http://127.0.0.1:43210/session/ses_target/message"]);
});

test("OpenCode probe harvests a terminal assistant message as parser-valid canonical raw", async () => {
  const messages = [{
    info: { id: "msg_done", sessionID: "ses_done", role: "assistant", finish: "stop", time: { completed: 42 }, tokens: { input: 3, output: 2 } },
    parts: [{ id: "prt_text", type: "text", text: "APPROVED" }, { id: "prt_done", type: "step-finish", reason: "stop" }],
  }];
  const fetchImpl = async (url) => url.endsWith("/session/status") ? response({}) : response(messages);
  const result = await createOpenCodeProbe({ url: "http://127.0.0.1:43210", fetchImpl })({ session_id: "ses_done", signal: new AbortController().signal });
  assert.equal(result.status, "completed");
  assert.equal(opencode.parse(result.raw.stdout, result.raw.stderr).ok, true);
  assert.equal(opencode.parse(result.raw.stdout, result.raw.stderr).text, "APPROVED");
});

test("OpenCode does not harvest a completed tool step while the session is still busy", async () => {
  const messages = [{ info: { id: "msg_tool", sessionID: "ses_busy", role: "assistant", finish: "tool-calls", time: { completed: 42 } }, parts: [{ id: "prt_tool", type: "step-finish", reason: "tool-calls" }] }];
  const fetchImpl = async (url) => url.endsWith("/session/status") ? response({ ses_busy: { type: "busy" } }) : response(messages);
  const result = await createOpenCodeProbe({ url: "http://127.0.0.1:43210", fetchImpl })({ session_id: "ses_busy" });
  assert.equal(result.status, "busy"); assert.equal(result.raw, null);
});

test("OpenCode probe maps retry, failed, idle progress, unknown session, HTTP failure, and abort", async () => {
  const message = [{ info: { id: "m", sessionID: "ses", role: "assistant" }, parts: [{ id: "p", type: "reasoning", text: "x" }] }];
  const make = (status, messages = message) => createOpenCodeProbe({ url: "http://127.0.0.1:43210", fetchImpl: async (url) => url.endsWith("/session/status") ? response(status) : response(messages) });
  assert.equal((await make({ ses: { type: "retry", attempt: 2 } })({ session_id: "ses" })).status, "retry");
  assert.equal((await make({ ses: { type: "idle" } })({ session_id: "ses", cursor: "old" })).status, "progressing");
  const failedMessage = [{ info: { id: "mf", sessionID: "ses", role: "assistant", finish: "error", error: { message: "boom" }, time: { completed: 9 } }, parts: [{ id: "pf", type: "step-finish", reason: "error" }] }];
  assert.equal((await make({}, failedMessage)({ session_id: "ses" })).status, "failed");
  assert.equal((await make({})({ session_id: "missing" })).status, "unverifiable");
  const badHttp = createOpenCodeProbe({ url: "http://127.0.0.1:43210", fetchImpl: async () => response({ error: "no" }, 503) });
  assert.equal((await badHttp({ session_id: "ses" })).status, "unverifiable");
  const controller = new AbortController(); controller.abort();
  assert.equal((await make({})({ session_id: "ses", signal: controller.signal })).status, "unverifiable");
});

test("OpenCode harvests a terminal session when its attached CLI hangs and cleans up the server", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-health-plan-")); const plan = opencode.start({ ...provider, command: healthFixture }, cwd, "review");
  const result = await execute(plan, { maxOutputBytes: 100_000, healthCheckIntervalMs: 100, probeDeadlineMs: 1_000, validateCompleted: (raw) => opencode.parse(raw.stdout, raw.stderr).ok });
  assert.equal(result.ok, true); assert.equal(result.health_harvested, true); assert.equal(opencode.parse(result.stdout, result.stderr).text, "FIXTURE_APPROVED");
  await assertEventuallyUnavailable(`${plan.healthServer.url}/global/health`);
});

test("OpenCode continuation harvests its known session when the attached client exits with no output", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-health-resume-")); const plan = opencode.resume({ ...provider, command: healthFixture }, cwd, "fixture_session", "continue");
  const result = await execute(plan, { maxOutputBytes: 100_000, healthCheckIntervalMs: 10_000, probeDeadlineMs: 1_000, validateCompleted: (raw) => opencode.parse(raw.stdout, raw.stderr).ok });
  assert.equal(result.ok, true); assert.equal(opencode.parse(result.stdout, result.stderr).session_id, "fixture_session"); assert.equal(opencode.parse(result.stdout, result.stderr).text, "FIXTURE_APPROVED");
});

test("OpenCode continuation fails explicitly when a zero-output client has no terminal session", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-health-missing-")); const plan = opencode.resume({ ...provider, command: healthFixture }, cwd, "missing_session", "continue");
  const result = await execute(plan, { maxOutputBytes: 100_000, healthCheckIntervalMs: 10_000, probeDeadlineMs: 1_000, validateCompleted: (raw) => opencode.parse(raw.stdout, raw.stderr).ok });
  assert.equal(result.ok, false); assert.match(result.stderr, /was not terminal after client exit/); assert.equal(result.stdout, "");
});
