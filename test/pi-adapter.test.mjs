import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pi from "../lib/adapters/pi.mjs";
import workspaceGuard, { isLogicalBundleRead, logicalWorkspaceSystemPrompt, reviewToolGate } from "../lib/adapters/pi-workspace-guard.mjs";
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
  assert.equal(execution.clientArgv[execution.clientArgv.indexOf("--tools") + 1], "read");
  assert.match(execution.clientArgv[execution.clientArgv.indexOf("--system-prompt") + 1], /read-only review analyst/);
  assert.match(execution.clientArgv[execution.clientArgv.indexOf("--system-prompt") + 1], /host-path fixture/);
  assert.match(pi.modelInstruction, /never quote, reproduce, construct, suggest, or create/i);
  assert.match(pi.modelInstruction, /host-path fixture/);
  assert.match(pi.publicOutputRewritePrompt, /^Your prior final response cannot be published/);
  assert.match(pi.publicOutputRewritePrompt, /complete replacement JSON review/);
  assert.match(pi.publicOutputRewritePrompt, /host-path fixture/);
  assert.doesNotMatch(pi.publicOutputRewritePrompt, /\/(?:Users|home|private|tmp|var|etc|opt|mnt|Volumes|root|usr|bin|sbin|dev|proc|sys|Library)\//);
  assert.match(execution.clientArgv[execution.clientArgv.indexOf("--extension") + 1], /pi-workspace-guard\.mjs$/);
  const result = await execute(execution, { maxOutputBytes: 100_000, healthCheckIntervalMs: 10_000 });
  assert.equal(result.ok, true);
  assert.equal(Buffer.byteLength(result.stdout) < 2_000, true);
  assert.deepEqual(pi.parse(result.stdout, result.stderr, execution.expectedSession), { ok: true, text: "PI_FINAL:review", session_id: execution.expectedSession, usage: { totalTokens: 7 } });
});

test("Pi workspace guard removes host cwd disclosure and permits only logical packet reads", () => {
  const guarded = logicalWorkspaceSystemPrompt("Review.\nCurrent working directory: /private/host/runtime");
  assert.equal(guarded, "Review.\nCurrent working directory: workspace");
  assert.equal(logicalWorkspaceSystemPrompt("Current working directory: /private/host\r\nReview.\r\nCurrent working directory: /private/host/runtime"), "Current working directory: workspace\r\nReview.\r\nCurrent working directory: workspace");
  for (const input of [{ path: "bundle/review-packet.v1.json" }, { path: "bundle/sections/changes.diff" }, { path: "bundle/changes.diff", offset: 101, limit: 100 }]) assert.equal(isLogicalBundleRead(input), true);
  for (const input of [{ path: "/private/host/runtime/bundle/review-packet.v1.json" }, { path: "bundle/../private.txt" }, { path: "bundle/attachments-manifest.json" }, { path: "file:///private/host" }, { path: "bundle\\review-packet.v1.json" }]) assert.equal(isLogicalBundleRead(input), false);
  assert.equal(reviewToolGate("read", { path: "bundle/review-packet.v1.json" }), null);
  const blocked = reviewToolGate("grep", { path: "/private/host" });
  assert.equal(blocked.block, true);
  assert.doesNotMatch(blocked.reason, /private|host|path:/i);
  const handlers = new Map();
  workspaceGuard({ on: (name, handler) => handlers.set(name, handler) });
  assert.equal(handlers.get("before_agent_start")({ systemPrompt: "x\nCurrent working directory: /private/host" }).systemPrompt.includes("/private/host"), false);
  assert.equal(handlers.get("tool_call")({ toolName: "read", input: { path: "bundle/review-packet.v1.json", offset: 101, limit: 100 } }), null);
  assert.equal(handlers.get("tool_call")({ toolName: "ls", input: {} }).block, true);
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
