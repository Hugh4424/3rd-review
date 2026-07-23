import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pi from "../lib/adapters/pi.mjs";
import { execute } from "../lib/process.mjs";
import { nodeFixtureCommand } from "./node-fixture-command.mjs";

const fake = nodeFixtureCommand(path.resolve("test/fake-pi-cli.mjs"));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-pi-test-"));
const provider = (overrides = {}) => ({ id: "pi", command: fake, model: "deepseek/deepseek-v4-flash", effort: "low", thinking: null, auth: { type: "native", env: [] }, env: [], ...overrides });
const transcript = (events) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
const complete = (session = "pi-session", options = {}) => transcript([
  { type: "pi.session", id: session, version: 3 },
  { type: "pi.progress", event: "thinking_delta" },
  { type: "pi.final", text: options.text ?? "PI_FINAL", model: "k3", usage: { totalTokens: 9 }, stop_reason: options.stopReason ?? "stop" },
  { type: "pi.agent_end", will_retry: options.willRetry ?? false },
  ...(options.settled === false ? [] : [{ type: "pi.agent_settled" }]),
]);

test("Pi supervises JSONL, keeps prompts on stdin, and persists a private native session", async () => {
  const runtime = temp(); const cwd = path.join(runtime, "work", "pi"); fs.mkdirSync(cwd, { recursive: true });
  const execution = pi.start(provider(), cwd, "review", runtime);
  assert.deepEqual(pi.capabilities.attachment_delivery, ["file_only", "always_embed"]);
  assert.equal(execution.command, process.execPath);
  assert.equal(execution.input, "review");
  assert.ok(execution.clientArgv.includes("--mode"));
  assert.equal(execution.clientArgv[execution.clientArgv.indexOf("--thinking") + 1], "low");
  assert.equal(execution.clientArgv[execution.clientArgv.indexOf("--session-id") + 1], execution.expectedSession);
  assert.equal(execution.clientArgv[execution.clientArgv.indexOf("--session-dir") + 1], path.join(runtime, "pi", "sessions"));
  const result = await execute(execution, { maxOutputBytes: 100_000, healthCheckIntervalMs: 10_000 });
  assert.equal(result.ok, true);
  assert.equal(Buffer.byteLength(result.stdout) < 2_000, true);
  assert.deepEqual(pi.parse(result.stdout, result.stderr, execution.expectedSession), { ok: true, text: "PI_FINAL:review", session_id: execution.expectedSession, usage: { totalTokens: 7 } });
});

test("Pi resume binds the same session and thinking falls back from compatibility booleans", () => {
  const runtime = temp(); const cwd = temp();
  const resume = pi.resume(provider(), cwd, "pi-session", "continue", runtime);
  assert.equal(resume.expectedSession, "pi-session");
  assert.equal(resume.clientArgv[resume.clientArgv.indexOf("--session") + 1], "pi-session");
  const off = pi.start(provider({ effort: null, thinking: false }), cwd, "review", runtime);
  assert.equal(off.clientArgv[off.clientArgv.indexOf("--thinking") + 1], "off");
});

test("Pi parser requires an exact settled successful session transcript", () => {
  assert.deepEqual(pi.parse(complete("pi-session"), "", "pi-session"), { ok: true, text: "PI_FINAL", session_id: "pi-session", usage: { totalTokens: 9 } });
  for (const value of [complete("wrong-session"), complete("pi-session", { settled: false }), complete("pi-session", { willRetry: true }), complete("pi-session", { stopReason: "error" }), complete("pi-session", { stopReason: "unknown" }), transcript([{ type: "pi.final", text: "forged", stop_reason: "stop" }]), `${complete("pi-session")}${JSON.stringify({ type: "pi.progress", event: "forged" })}\n`]) assert.equal(pi.parse(value, "", "pi-session").ok, false);
  assert.equal(pi.parse(`${complete("pi-session")}not-json\n`, "", "pi-session").ok, false);
});

test("Pi progress does not preserve repeated raw thinking snapshots", () => {
  assert.deepEqual(pi.observeLine("stdout", JSON.stringify({ type: "pi.session", id: "pi-session" })), { liveness: true, progress: false, event: "pi.session", session_id: "pi-session" });
  assert.deepEqual(pi.observeLine("stdout", JSON.stringify({ type: "pi.progress", event: "thinking_delta" })), { liveness: true, progress: true, event: "thinking_delta" });
  assert.equal(pi.observeLine("stdout", "bad").progress, false);
});

test("Pi wrapper rejects malformed terminal events and oversized raw JSONL", async () => {
  const runtime = temp(); const cwd = temp();
  for (const env of [["PI_FAKE_MISSING_WILL_RETRY"], ["PI_FAKE_OVERSIZED_UPDATE"]]) {
    const name = env[0]; const old = process.env[name]; process.env[name] = "1";
    try {
      const execution = pi.start(provider({ env }), cwd, "review", runtime);
      const result = await execute(execution, { maxOutputBytes: 100_000, healthCheckIntervalMs: 10_000 });
      assert.equal(result.ok, false);
      assert.match(result.stderr, /willRetry|larger than/);
    } finally {
      if (old === undefined) delete process.env[name]; else process.env[name] = old;
    }
  }
});

test("Pi wrapper handles an unexecutable native CLI without an uncaught stdin error", async () => {
  const execution = pi.start(provider({ command: "/definitely/not/a/pi-cli" }), temp(), "review", temp());
  const result = await execute(execution, { maxOutputBytes: 100_000, healthCheckIntervalMs: 10_000 });
  assert.equal(result.ok, false);
});
