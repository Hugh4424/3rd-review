import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import kimi from "../lib/adapters/kimi.mjs";
import { execute } from "../lib/process.mjs";

const provider = { id: "kimi", command: "kimi", model: null, thinking: null, auth: { env: [] }, env: [] };
const session = "12345678-1234-1234-1234-123456789abc";

function feed(plan, value) { return plan.observeLine("stdout", JSON.stringify(value)); }
function hint(plan) { return plan.observeLine("stderr", `To resume this session: kimi -r ${session}`); }

test("Kimi uses Wire initialize and prompt requests and official session resume", () => {
  const first = kimi.start(provider, "/tmp/work", "review", "/tmp/runtime");
  assert.deepEqual(first.argv.slice(0, 1), ["--wire"]);
  assert.equal(first.argv.includes("--afk"), true);
  assert.equal(first.keepStdinOpen, true);
  const requests = first.input.trim().split("\n").map(JSON.parse);
  assert.equal(requests[0].method, "initialize");
  assert.equal(requests[0].params.protocol_version, "1.10");
  assert.equal(requests[1].method, "prompt");
  assert.equal(requests[1].params.user_input, "review");
  const resumed = kimi.resume(provider, "/tmp/work", session, "delta", "/tmp/runtime");
  assert.deepEqual(resumed.argv.slice(-2), ["--session", session]);
});

test("Kimi Wire events expose progress and a finished turn exposes completed raw", async () => {
  const plan = kimi.start(provider, "/tmp/work", "review", "/tmp/runtime");
  const progress = feed(plan, { jsonrpc: "2.0", method: "event", params: { type: "StepBegin", payload: { n: 1 } } });
  assert.equal(progress.progress, true);
  assert.equal((await plan.probeSession()).status, "progressing");
  feed(plan, { jsonrpc: "2.0", method: "event", params: { type: "TextPart", payload: { text: "APPROVED" } } });
  const terminal = feed(plan, { jsonrpc: "2.0", id: "prompt", result: { status: "finished" } });
  assert.equal(terminal.terminal.state, "completed");
  hint(plan);
  const health = await plan.probeSession();
  assert.equal(health.status, "completed");
  assert.match(health.raw.stdout, /APPROVED/);
  const parsed = kimi.parse(health.raw.stdout, `To resume this session: kimi -r ${session}`);
  assert.deepEqual(parsed, { ok: true, text: "APPROVED", session_id: session, usage: null });
});

test("Kimi Wire preserves every assistant text part in order", () => {
  const stdout = [
    { jsonrpc: "2.0", method: "event", params: { type: "ContentPart", payload: { type: "text", text: "APPRO" } } },
    { jsonrpc: "2.0", method: "event", params: { type: "ContentPart", payload: { type: "text", text: "VED" } } },
    { jsonrpc: "2.0", id: "prompt", result: { status: "finished" } },
  ].map(JSON.stringify).join("\n");
  assert.equal(kimi.parse(stdout, `To resume this session: kimi -r ${session}`).text, "APPROVED");
});

test("Kimi Wire terminal cancellation and failure are not semantic completion", async () => {
  for (const response of [
    { result: { status: "cancelled" }, code: "CANCELLED" },
    { result: { status: "max_steps_reached" }, code: "PROVIDER_MAX_STEPS" },
    { error: { code: -32603, message: "boom" }, code: "PROVIDER_WIRE_FAILED" },
  ]) {
    const plan = kimi.start(provider, "/tmp/work", "review", "/tmp/runtime");
    feed(plan, { jsonrpc: "2.0", id: "prompt", ...(response.result ? { result: response.result } : { error: response.error }) });
    const health = await plan.probeSession();
    assert.equal(health.status, "failed");
    assert.equal(health.error.code, response.code);
  }
});

test("Kimi Wire parser rejects partial text plus resume hint without a finished prompt response", () => {
  const partial = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "ContentPart", payload: { type: "text", text: "PARTIAL" } } });
  for (const terminal of [
    null,
    { jsonrpc: "2.0", id: "prompt", result: { status: "cancelled" } },
    { jsonrpc: "2.0", id: "prompt", result: { status: "max_steps_reached" } },
    { jsonrpc: "2.0", id: "prompt", error: { code: -32603, message: "boom" } },
  ]) {
    const stdout = [partial, terminal && JSON.stringify(terminal)].filter(Boolean).join("\n");
    const parsed = kimi.parse(stdout, `To resume this session: kimi -r ${session}`);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "PROVIDER_OUTPUT_INVALID");
  }
});

test("Kimi Wire rejects every second response for the same prompt id", async () => {
  for (const first of [
    { jsonrpc: "2.0", id: "prompt", result: { status: "cancelled" } },
    { jsonrpc: "2.0", id: "prompt", error: { code: -32603, message: "boom" } },
  ]) {
    const plan = kimi.start(provider, "/tmp/work", "review", "/tmp/runtime");
    const text = { jsonrpc: "2.0", method: "event", params: { type: "ContentPart", payload: { type: "text", text: "APPROVED" } } };
    const finished = { jsonrpc: "2.0", id: "prompt", result: { status: "finished" } };
    feed(plan, text); feed(plan, first); feed(plan, finished); hint(plan);
    const health = await plan.probeSession();
    assert.equal(health.status, "unverifiable");
    assert.equal(health.error.code, "PROVIDER_WIRE_INVALID");
    const stdout = [text, first, finished].map(JSON.stringify).join("\n");
    assert.equal(kimi.parse(stdout, `To resume this session: kimi -r ${session}`).ok, false);
  }
});

test("Kimi Wire reports an explicit retry event as retry health", async () => {
  const plan = kimi.start(provider, "/tmp/work", "review", "/tmp/runtime");
  feed(plan, { jsonrpc: "2.0", method: "event", params: { type: "StepRetry", payload: { n: 1, next_attempt: 2, max_attempts: 3, wait_s: 1, error_type: "APIEmptyResponseError" } } });
  assert.equal((await plan.probeSession()).status, "retry");
});

test("Kimi Wire initialize method-not-found is compatible but other protocol uncertainty is unverifiable", async () => {
  const compatible = kimi.start(provider, "/tmp/work", "review", "/tmp/runtime");
  feed(compatible, { jsonrpc: "2.0", id: "initialize", error: { code: -32601, message: "method not found" } });
  assert.equal((await compatible.probeSession()).status, "progressing");
  const uncertain = kimi.start(provider, "/tmp/work", "review", "/tmp/runtime");
  feed(uncertain, { jsonrpc: "2.0", id: "initialize", error: { code: -32600, message: "bad initialize" } });
  assert.equal((await uncertain.probeSession()).status, "unverifiable");
});

test("Kimi Wire probe honors AbortSignal and reports quiet work as busy", async () => {
  const plan = kimi.start(provider, "/tmp/work", "review", "/tmp/runtime");
  assert.equal((await plan.probeSession()).status, "busy");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => plan.probeSession({ signal: controller.signal }), { name: "AbortError" });
});

test("Kimi Wire fixture stays open through terminal and preserves the resume hint", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wire-fixture-")); fs.mkdirSync(path.join(cwd, "skills"));
  const fake = { ...provider, command: path.resolve("test/fake-kimi-wire-cli.mjs") };
  const result = await execute(kimi.start(fake, cwd, "review", cwd), { maxOutputBytes: 100_000, healthCheckIntervalMs: 60_000 });
  const parsed = kimi.parse(result.stdout, result.stderr);
  assert.equal(result.ok, true);
  assert.equal(parsed.text, "WIRE_FIXTURE_OK");
  assert.equal(parsed.session_id, session);
  fs.rmSync(cwd, { recursive: true, force: true });
});
