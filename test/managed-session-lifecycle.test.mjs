import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { Broker } from "../lib/broker.mjs";
import { validateConfig } from "../lib/config.mjs";
import { cleanup, isAlive, readRuntime, updateRuntime } from "../lib/runtime.mjs";

const fake = path.resolve("test/fake-cli.mjs");
const slow = path.resolve("test/slow-cli.mjs");
const slowSuccess = path.resolve("test/slow-success-cli.mjs");
const caller = path.resolve("test/managed-start-caller.mjs");
const cli = path.resolve("scripts/3rd-review.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-managed-"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash("sha256").update(value).digest("hex");

function source(root, name = "review-instructions.md", contents = "review packet") {
  const directory = path.join(root, `source-${name.replace(/[^a-z]/g, "")}-${Math.random().toString(16).slice(2)}`); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, name), contents); const sha256 = hash(contents);
  return { root: directory, attachment: { root: directory, delivery: "file_only", manifest: { version: 1, bundle_id: `managed-${sha256.slice(0, 12)}`, entries: [{ source: name, destination: name, size: Buffer.byteLength(contents), sha256, embed: false }] } } };
}
function config(root, sources, providers, tiers = [Object.keys(providers)]) {
  return validateConfig({ version: 4, runtime: { root, ttl_hours: 24, max_prompt_bytes: 10_000, max_output_bytes: 100_000, liveness_interval_ms: 5, orphan_timeout_ms: 100 }, attachment_roots: sources.map((item) => ({ root: item.root, sources: item.attachment.manifest.entries.map((entry) => entry.source) })), tiers, providers });
}
function provider(command, extra = {}) { return { enabled: true, command, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [], ...extra }; }
function request(attachment, prompt = "review", continuation = null, allowlist = ["kimi"]) { return { version: 4, host_provider: "codex", required_result_protocol: "workflowhub-result.v2", provider_allowlist: allowlist, prompt, continuation, attachments: attachment }; }
async function terminal(broker, runtimeId, timeout = 4_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = broker.managedStatus(runtimeId); if (value.state === "terminal") return value; await delay(20); }
  assert.fail("managed review did not finish");
}
async function spawnedStart(configPath, requestPath, requestId) {
  const child = spawn(process.execPath, [caller, configPath, requestPath, requestId], { stdio: ["ignore", "pipe", "pipe"] }); let text = "";
  await new Promise((resolve, reject) => { child.stdout.on("data", (chunk) => { text += chunk; if (text.includes("\n")) resolve(); }); child.once("error", reject); child.once("close", (code) => reject(new Error(`caller exited before start: ${code}`))); });
  const start = JSON.parse(text.trim()); assert.equal(child.kill("SIGTERM"), true); await new Promise((resolve) => child.once("close", resolve)); return start;
}
function callCli(args) {
  return new Promise((resolve) => { const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.once("close", (code) => resolve({ code, stdout, stderr })); });
}

test("managed start survives a SIGTERM caller and reconnects through public status", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slowSuccess) });
  const configPath = path.join(root, "config.json"); const requestPath = path.join(root, "request.json"); fs.writeFileSync(configPath, JSON.stringify(value)); fs.writeFileSync(requestPath, JSON.stringify(request(material.attachment)));
  const start = await spawnedStart(configPath, requestPath, "caller-survives"); assert.equal(start.state === "starting" || start.state === "running", true);
  const finished = await terminal(new Broker(value), start.runtime_id); assert.equal(finished.group.providers[0].status, "completed"); assert.equal(finished.group.providers[0].raw_output_ref, null);
  assert.equal(JSON.stringify(finished).includes(root), false);
});

test("managed public status follows the current operation from starting through running to terminal", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slow) }); const broker = new Broker(value);
  const start = broker.startManaged(request(material.attachment), "status-transition");
  assert.equal(start.state, "starting"); assert.equal(Object.hasOwn(start, "group"), false);

  let operation;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    operation = readRuntime(root, start.runtime_id).managed.operations[0];
    if (operation.state === "running") break;
    await delay(10);
  }
  assert.equal(operation.state, "running");
  const running = broker.managedStatus(start.runtime_id);
  assert.equal(running.state, "running"); assert.equal(Object.hasOwn(running, "group"), false);

  const cancelled = broker.cancelManaged(start.runtime_id);
  assert.equal(cancelled.state === "running" || cancelled.state === "terminal", true);
  const finished = await terminal(broker, start.runtime_id);
  assert.equal(finished.state, "terminal"); assert.equal(Object.hasOwn(finished, "group"), true);
  assert.equal(finished.group.providers[0].error.code, "CANCELLED");
});

test("CLI exposes public managed start, status, and provider-free cancel", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slow) }); const configPath = path.join(root, "config.json"); const requestPath = path.join(root, "request.json"); fs.writeFileSync(configPath, JSON.stringify(value)); fs.writeFileSync(requestPath, JSON.stringify(request(material.attachment)));
  const startCall = await callCli(["start", `--config=${configPath}`, `--request=${requestPath}`, "--request-id=cli-managed"]); assert.equal(startCall.code, 0, startCall.stderr); const start = JSON.parse(startCall.stdout);
  const running = await callCli(["status", `--config=${configPath}`, `--runtime-id=${start.runtime_id}`]); assert.equal(running.code, 0, running.stderr); assert.equal(Object.hasOwn(JSON.parse(running.stdout), "group"), false);
  const legacyCancel = await callCli(["cancel", `--config=${configPath}`, `--runtime-id=${start.runtime_id}`, "--provider=kimi"]); assert.equal(legacyCancel.code, 2); assert.equal(JSON.parse(legacyCancel.stderr).error.code, "MANAGED_CANCEL_REQUIRED");
  const cancel = await callCli(["cancel", `--config=${configPath}`, `--runtime-id=${start.runtime_id}`]); assert.equal(cancel.code, 0, cancel.stderr);
  const finished = await terminal(new Broker(value), start.runtime_id); assert.equal(finished.group.providers[0].error.code, "CANCELLED");
});

test("managed start is request-id idempotent and rejects a changed immutable binding", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slowSuccess) }); const broker = new Broker(value);
  const first = broker.startManaged(request(material.attachment, "one"), "same-request"); const duplicate = broker.startManaged(request(material.attachment, "one"), "same-request");
  assert.equal(first.runtime_id, duplicate.runtime_id); await terminal(broker, first.runtime_id);
  const raw = path.join(root, first.runtime_id, "raw", "kimi"); assert.equal(fs.readdirSync(raw).filter((name) => name.endsWith(".stdout")).length, 1);
  assert.throws(() => broker.startManaged(request(material.attachment, "different"), "same-request"), { code: "REQUEST_ID_CONFLICT" });
});

test("expired managed runtime removes its request-id binding with the runtime", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slowSuccess) }); const broker = new Broker(value);
  const first = broker.startManaged(request(material.attachment), "expires-with-runtime"); await terminal(broker, first.runtime_id);
  updateRuntime(root, first.runtime_id, (state) => ({ ...state, expires_at_ms: 0 })); cleanup(root, 24);
  assert.equal(fs.existsSync(path.join(root, first.runtime_id)), false); assert.equal(fs.readdirSync(path.join(root, "managed-requests")).length, 0);
  const restarted = new Broker(value).startManaged(request(material.attachment), "expires-with-runtime"); assert.notEqual(restarted.runtime_id, first.runtime_id); await terminal(new Broker(value), restarted.runtime_id);
});

test("managed cancel is the only provider stop path and publishes a terminal cancelled group", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slow) }); const broker = new Broker(value);
  const start = broker.startManaged(request(material.attachment), "cancelled-request");
  for (let attempt = 0; attempt < 100 && !readRuntime(root, start.runtime_id).providers.kimi; attempt += 1) await delay(10);
  broker.cancelManaged(start.runtime_id); const finished = await terminal(broker, start.runtime_id);
  assert.equal(finished.group.providers[0].status, "cancelled"); assert.equal(finished.group.providers[0].error.code, "CANCELLED");
});

test("lost manager publishes SESSION_MANAGER_LOST without signalling a healthy provider, then explicit cancel stops it", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slow) }); const broker = new Broker(value);
  const start = broker.startManaged(request(material.attachment), "manager-lost"); let state;
  for (let attempt = 0; attempt < 100; attempt += 1) { state = readRuntime(root, start.runtime_id); if (state.managed.operations[0].manager && state.providers.kimi?.worker) break; await delay(10); }
  assert.ok(state.managed.operations[0].manager?.pid); const providerPid = state.providers.kimi.pid; assert.equal(process.kill(state.managed.operations[0].manager.pid, "SIGTERM"), true);
  await delay(30); const lost = broker.managedStatus(start.runtime_id); assert.equal(lost.state, "terminal"); assert.equal(lost.group.providers[0].error.code, "SESSION_MANAGER_LOST"); assert.equal(isAlive(providerPid), true);
  assert.throws(() => broker.cancel(start.runtime_id, "kimi"), { code: "MANAGED_CANCEL_REQUIRED" });
  const cancelled = broker.cancelManaged(start.runtime_id); assert.equal(cancelled.group.providers[0].error.code, "CANCELLED");
  for (let attempt = 0; attempt < 100 && isAlive(providerPid); attempt += 1) await delay(10); assert.equal(isAlive(providerPid), false);
});

test("fast managed completion preserves its terminal group", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(fake) }); const broker = new Broker(value);
  for (let index = 0; index < 4; index += 1) {
    const started = broker.startManaged(request(material.attachment, `fast-${index}`), `fast-${index}`);
    const finished = await terminal(broker, started.runtime_id);
    assert.equal(finished.group.providers[0].status, "completed");
    assert.notEqual(finished.group.providers[0].error?.code, "SESSION_MANAGER_LOST");
  }
});

test("managed public terminal group keeps a polluted provider isolated and private paths absent", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], {
    "kimi/k3": provider(fake, { env: ["THIRD_REVIEW_FAKE_KIMI_OUTPUT"] }), "claude-code/opus": provider(fake),
  }, [["kimi/k3", "claude-code/opus"]]);
  process.env.THIRD_REVIEW_FAKE_KIMI_OUTPUT = "contains /private/managed-secret";
  try {
    const finished = await terminal(new Broker(value), new Broker(value).startManaged(request(material.attachment, "review", null, ["kimi/k3", "claude-code/opus"]), "polluted").runtime_id);
    assert.equal(finished.group.providers[0].error?.code, "PUBLIC_RESULT_INVALID", JSON.stringify(finished)); assert.equal(finished.group.providers[1].status, "completed");
    assert.equal(JSON.stringify(finished).includes("/private/managed-secret"), false);
  } finally { delete process.env.THIRD_REVIEW_FAKE_KIMI_OUTPUT; }
});

test("managed terminal status rejects an unbound or expanded public group", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(fake) }); const broker = new Broker(value);
  const cases = [
    (group) => { group.extra = true; },
    (group) => { group.runtime_id = "other-runtime"; },
    (group) => { group.providers[0].runtime_id = "other-runtime"; },
    (group) => { group.providers[0].material_id = "other-material"; },
    (group) => { group.providers[0].status = "failed"; group.providers[0].error = { code: "PROBE_FAILED", message: "" }; group.providers[0].unavailable_diagnostics = { code: "PROBE_FAILED", message: "" }; },
    (group) => { group.providers[0].status = "failed"; group.providers[0].error = { code: "PROBE_FAILED", message: "public error" }; group.providers[0].unavailable_diagnostics = { code: "OTHER", message: "different diagnostic" }; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const start = broker.startManaged(request(material.attachment, `invalid-${index}`), `invalid-${index}`); await terminal(broker, start.runtime_id);
    updateRuntime(root, start.runtime_id, (state) => ({ ...state, managed: { ...state.managed, operations: state.managed.operations.map((operation) => operation.operation_id === state.managed.operations.at(-1).operation_id ? { ...operation, group: (() => { const group = structuredClone(operation.group); mutate(group); return group; })() } : operation) } }));
    assert.throws(() => broker.managedStatus(start.runtime_id), { code: "PUBLIC_RESULT_INVALID" });
  }
});

test("managed continuation creates one distinct non-overlapping operation", async () => {
  const root = temp(); const firstMaterial = source(root, "one.md", "one"); const nextMaterial = source(root, "two.md", "two"); const value = config(root, [firstMaterial, nextMaterial], { kimi: provider(fake) }); const broker = new Broker(value);
  const first = broker.startManaged(request(firstMaterial.attachment, "first"), "round-one"); await terminal(broker, first.runtime_id);
  const secondRequest = request(nextMaterial.attachment, "second", { runtime_id: first.runtime_id }); const second = broker.startManaged(secondRequest, "round-two");
  assert.throws(() => broker.startManaged(secondRequest, "round-three"), { code: "OPERATION_ACTIVE" }); await terminal(broker, second.runtime_id);
  const state = readRuntime(root, first.runtime_id); assert.equal(state.managed.operations.length, 2); assert.notEqual(state.managed.operations[0].operation_id, state.managed.operations[1].operation_id);
});

test("concurrent distinct managed continuation starts atomically admit one operation", async () => {
  const root = temp(); const firstMaterial = source(root, "one.md", "one"); const nextMaterial = source(root, "two.md", "two"); const value = config(root, [firstMaterial, nextMaterial], { kimi: provider(slowSuccess) }); const configPath = path.join(root, "config.json"); const firstPath = path.join(root, "first.json"); const nextPath = path.join(root, "next.json"); fs.writeFileSync(configPath, JSON.stringify(value)); fs.writeFileSync(firstPath, JSON.stringify(request(firstMaterial.attachment, "first")));
  const initialCall = await callCli(["start", `--config=${configPath}`, `--request=${firstPath}`, "--request-id=race-initial"]); assert.equal(initialCall.code, 0, initialCall.stderr); const initial = JSON.parse(initialCall.stdout); await terminal(new Broker(value), initial.runtime_id);
  fs.writeFileSync(nextPath, JSON.stringify(request(nextMaterial.attachment, "next", { runtime_id: initial.runtime_id })));
  const calls = await Promise.all([callCli(["start", `--config=${configPath}`, `--request=${nextPath}`, "--request-id=race-a"]), callCli(["start", `--config=${configPath}`, `--request=${nextPath}`, "--request-id=race-b"])]);
  assert.deepEqual(calls.map((item) => item.code).sort(), [0, 2]); const rejected = calls.find((item) => item.code === 2); assert.equal(JSON.parse(rejected.stderr).error.code, "OPERATION_ACTIVE"); const winner = JSON.parse(calls.find((item) => item.code === 0).stdout); await terminal(new Broker(value), winner.runtime_id);
  assert.equal(readRuntime(root, initial.runtime_id).managed.operations.length, 2);
});
