import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { Broker } from "../lib/broker.mjs";
import { validateConfig } from "../lib/config.mjs";
import { cleanup, createRuntime, currentOwnerIdentity, ensureRuntimeGuardian, processIdentity, readRuntime, reapRuntimeIfOwnerDead, updateRuntime, workerIdentityMatches } from "../lib/runtime.mjs";

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
function rematerializedSource(root, prefix, contents = "review packet") {
  const directory = path.join(root, `source-${prefix}`); const sourcePath = `${prefix}/review-instructions.md`;
  fs.mkdirSync(path.join(directory, prefix), { recursive: true }); fs.writeFileSync(path.join(directory, sourcePath), contents); const sha256 = hash(contents);
  return { root: directory, attachment: { root: directory, delivery: "file_only", manifest: { version: 1, bundle_id: `managed-${sha256.slice(0, 12)}`, entries: [{ source: sourcePath, destination: "review-instructions.md", size: Buffer.byteLength(contents), sha256, embed: false }] } } };
}
function config(root, sources, providers, tiers = [Object.keys(providers)]) {
  return validateConfig({ version: 4, runtime: { root, ttl_hours: 24, max_prompt_bytes: 10_000, max_output_bytes: 100_000, liveness_interval_ms: 5, orphan_timeout_ms: 100 }, attachment_roots: sources.map((item) => ({ root: item.root, sources: item.attachment.manifest.entries.map((entry) => entry.source) })), tiers, providers });
}
function provider(command, extra = {}) { return { enabled: true, command, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [], ...extra }; }
function request(attachment, prompt = "review", continuation = null, allowlist = ["kimi"]) { return { version: 4, host_provider: "codex", required_result_protocol: "workflowhub-result.v2", provider_allowlist: allowlist, prompt, continuation, attachments: attachment }; }
function sigtermIgnoringProvider(root) {
  const command = path.join(root, "sigterm-ignoring-provider.mjs");
  const ready = path.join(root, "provider-sigterm-handler-ready");
  // Provider adapters append their native CLI flags after the configured
  // command. A shell script ignores those positional arguments and traps
  // SIGTERM, while its sleep child is replaceable. The ready marker lets the
  // test avoid racing a signal against handler installation.
  const quotedReady = `'${ready.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(command, `#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' "$$" > ${quotedReady}\nwhile :; do /bin/sleep 10; done\n`, { mode: 0o700 });
  fs.chmodSync(command, 0o700);
  return { command, ready };
}
function heldProviderUntilRelease(root) {
  const command = path.join(root, "held-provider-until-release.sh");
  const ready = path.join(root, "held-provider-ready");
  const release = path.join(root, "held-provider-release");
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const script = [
    "#!/bin/sh",
    "printf 'ready\\n' > " + quote(ready),
    "while [ ! -e " + quote(release) + " ]; do /bin/sleep 0.01; done",
    "exec " + quote(process.execPath) + " " + quote(slowSuccess) + " \"$@\"",
    "",
  ].join("\n");
  fs.writeFileSync(command, script, { mode: 0o700 });
  fs.chmodSync(command, 0o700);
  return { command, ready, release };
}
function hideManagedManagerIdentityOnce(root, providerReady) {
  const directory = path.join(root, "ps-shim"); fs.mkdirSync(directory, { mode: 0o700 });
  const command = path.join(directory, "ps"); const hidden = path.join(directory, "manager-identity-hidden");
  const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(command, `#!/bin/sh
pid=""
for arg do pid="$arg"; done
target_parent=$(/bin/ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
if [ "$pid" != "$PPID" ] && [ "$target_parent" = "$PPID" ]; then
  attempt=0
  target=""
  while [ "$attempt" -lt 300 ]; do
    target=$(/bin/ps -o command= -p "$pid" 2>/dev/null)
    case "$target" in *managed-session-manager.mjs*) break ;; esac
    /bin/sleep 0.01
    attempt=$((attempt + 1))
  done
  case "$target" in
    *managed-session-manager.mjs*)
      if [ ! -e ${quoted(hidden)} ]; then
        attempt=0
        while [ ! -e ${quoted(providerReady)} ] && [ "$attempt" -lt 300 ]; do /bin/sleep 0.01; attempt=$((attempt + 1)); done
        if [ -e ${quoted(providerReady)} ]; then printf '%s\\n' "$pid" > ${quoted(hidden)}; exit 1; fi
      fi
      ;;
  esac
fi
exec /bin/ps "$@"
`, { mode: 0o700 });
  fs.chmodSync(command, 0o700);
  return { directory, hidden };
}
async function terminal(broker, runtimeId, timeout = 4_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = broker.managedStatus(runtimeId); if (value.state === "terminal") return value; await delay(20); }
  assert.fail("managed review did not finish");
}
async function removeTempTree(root) {
  const makeDirectoriesWritable = (directory) => {
    if (!fs.existsSync(directory)) return;
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) makeDirectoriesWritable(path.join(directory, entry.name));
    }
  };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { makeDirectoriesWritable(root); fs.rmSync(root, { recursive: true, force: true }); return; }
    catch (error) { if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error; await delay(25); }
  }
  makeDirectoriesWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
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

test("managed health matches the WorkflowHub consumer contract", async () => {
  const root = temp(); const material = source(root);
  const providerIds = ["kimi", "claude-code"];
  const value = config(root, [material], {
    kimi: provider(slow),
    "claude-code": provider(fake),
  }, [providerIds]);
  const broker = new Broker(value);
  const review = request(material.attachment, "provider health", null, providerIds);
  const start = broker.startManaged(review, "provider-health");
  let finished;

  function assertHealth(envelope, allowedStatuses) {
    assert.ok(envelope.providers && typeof envelope.providers === "object" && !Array.isArray(envelope.providers));
    assert.deepEqual(Object.keys(envelope.providers).sort(), [...providerIds].sort());
    for (const id of providerIds) {
      const health = envelope.providers[id];
      assert.ok(health && typeof health === "object" && !Array.isArray(health));
      assert.ok(allowedStatuses.includes(health.status), `${id} status ${health.status} is accepted by WorkflowHub`);
      assert.equal(Object.hasOwn(health, "last_progress_at_ms"), true);
      assert.ok(health.last_progress_at_ms === null
        || (Number.isSafeInteger(health.last_progress_at_ms) && health.last_progress_at_ms >= 0));
    }
  }

  try {
    assert.ok(["starting", "running"].includes(start.state));
    assert.equal(Object.hasOwn(start, "group"), false);
    assertHealth(start, ["pending", "running", "completed"]);
    assert.ok(["pending", "running"].includes(start.providers.kimi.status));

    let state;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      state = readRuntime(root, start.runtime_id);
      if (state.providers.kimi?.status === "running" && state.providers["claude-code"]?.status === "completed") break;
      await delay(10);
    }
    assert.equal(state.providers.kimi?.status, "running");
    assert.equal(state.providers["claude-code"]?.status, "completed");

    const running = broker.managedStatus(start.runtime_id);
    assert.equal(running.state, "running");
    assert.equal(Object.hasOwn(running, "group"), false);
    assertHealth(running, ["pending", "running", "completed", "failed", "cancelled"]);
    assert.equal(running.providers.kimi.status, "running");
    assert.equal(running.providers["claude-code"].status, "completed");

    broker.cancelManaged(start.runtime_id);
    finished = await terminal(broker, start.runtime_id);
  } finally {
    if (broker.managedStatus(start.runtime_id).state !== "terminal") broker.cancelManaged(start.runtime_id);
    await terminal(broker, start.runtime_id);
  }

  assert.equal(finished.state, "terminal");
  assert.equal(Object.hasOwn(finished, "providers"), false);
  assert.equal(Object.hasOwn(finished, "group"), true);
});

test("managed health stays running without progress beyond ten minutes until the provider reaches terminal", async (t) => {
  const root = temp(); const material = source(root); const held = heldProviderUntilRelease(root);
  const value = config(root, [material], { kimi: provider(held.command) }); const broker = new Broker(value);
  const start = broker.startManaged(request(material.attachment), "managed-health-no-deadline");
  let finished = null;

  try {
    for (let attempt = 0; attempt < 300 && !fs.existsSync(held.ready); attempt += 1) await delay(10);
    assert.equal(fs.existsSync(held.ready), true, "provider started and is holding without output");
    let state;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      state = readRuntime(root, start.runtime_id);
      if (state.managed.operations[0].state === "running" && state.providers.kimi?.status === "running") break;
      await delay(10);
    }
    assert.equal(state.managed.operations[0].state, "running");
    assert.equal(state.providers.kimi.status, "running");
    const worker = state.providers.kimi.worker;
    const lastProgressAt = state.providers.kimi.last_progress_at_ms;
    assert.equal(lastProgressAt, null, "the provider has not emitted progress");

    const beforeElapsedJump = Date.now();
    t.mock.method(Date, "now", () => beforeElapsedJump + 600_001);
    let afterElapsed;
    try { afterElapsed = broker.managedStatus(start.runtime_id); }
    finally { t.mock.restoreAll(); }

    assert.equal(afterElapsed.state, "running");
    assert.equal(afterElapsed.providers.kimi.status, "running");
    assert.equal(afterElapsed.providers.kimi.last_progress_at_ms, lastProgressAt);
    assert.equal(readRuntime(root, start.runtime_id).managed.operations[0].cancel_requested, false);
    assert.equal(workerIdentityMatches(worker), true, "elapsed time must not stop the active provider");

    fs.writeFileSync(held.release, "terminal\n");
    finished = await terminal(broker, start.runtime_id);
    assert.equal(finished.state, "terminal");
    assert.equal(finished.group.providers[0].status, "completed");
    assert.equal(finished.group.providers[0].output, "slow opinion");
  } finally {
    t.mock.restoreAll();
    if (broker.managedStatus(start.runtime_id).state !== "terminal") broker.cancelManaged(start.runtime_id);
    if (!finished) await terminal(broker, start.runtime_id);
    await removeTempTree(root);
  }
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

test("managed start reconnects when an equivalent sealed packet has a new staging source", async () => {
  const root = temp(); const firstMaterial = rematerializedSource(root, "first"); const rebuiltMaterial = rematerializedSource(root, "rebuilt"); const changedMaterial = rematerializedSource(root, "changed");
  changedMaterial.attachment.manifest.entries[0].destination = "changed-review-instructions.md";
  const value = config(root, [firstMaterial, rebuiltMaterial, changedMaterial], { kimi: provider(slowSuccess) }); const broker = new Broker(value);
  const first = broker.startManaged(request(firstMaterial.attachment, "one"), "same-rematerialized-request");
  const reconnected = broker.startManaged(request(rebuiltMaterial.attachment, "one"), "same-rematerialized-request");
  assert.equal(reconnected.runtime_id, first.runtime_id);
  assert.throws(() => broker.startManaged(request(changedMaterial.attachment, "one"), "same-rematerialized-request"), { code: "REQUEST_ID_CONFLICT" });
  await terminal(broker, first.runtime_id);
  const raw = path.join(root, first.runtime_id, "raw", "kimi"); assert.equal(fs.readdirSync(raw).filter((name) => name.endsWith(".stdout")).length, 1);
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

test("lost manager reaps the orphaned provider before publishing SESSION_MANAGER_LOST", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slow) }); const broker = new Broker(value);
  const start = broker.startManaged(request(material.attachment), "manager-lost"); let state;
  for (let attempt = 0; attempt < 100; attempt += 1) { state = readRuntime(root, start.runtime_id); if (state.managed.operations[0].manager && state.providers.kimi?.worker) break; await delay(10); }
  const manager = state.managed.operations[0].manager; const worker = state.providers.kimi.worker;
  assert.ok(manager?.pid); assert.equal(process.kill(manager.pid, "SIGTERM"), true);
  let lost = null; const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    lost = broker.managedStatus(start.runtime_id);
    if (lost.state === "terminal") { assert.equal(workerIdentityMatches(worker), false); break; }
    assert.equal(lost.state, "running"); await delay(25);
  }
  assert.ok(lost?.state === "terminal");
  assert.equal(lost.group.providers[0].error.code, "SESSION_MANAGER_LOST");
  assert.equal(workerIdentityMatches(worker), false);
  assert.equal(readRuntime(root, start.runtime_id).providers.kimi.cleanup_status, "confirmed");
});

test("managed start stays nonterminal when manager PID identity is unavailable after provider start", async () => {
  const root = temp(); const material = source(root); const fakeProvider = sigtermIgnoringProvider(root);
  const shim = hideManagedManagerIdentityOnce(root, fakeProvider.ready);
  const value = config(root, [material], { kimi: provider(fakeProvider.command) }); const broker = new Broker(value);
  const originalPath = process.env.PATH; let start = null; let manager = null; let worker = null; let guardian = null;
  try {
    process.env.PATH = [shim.directory, originalPath ?? ""].join(path.delimiter);
    start = broker.startManaged(request(material.attachment), "manager-identity-query-race");
    process.env.PATH = originalPath;

    assert.equal(fs.existsSync(shim.hidden), true, "the test hides only the spawned manager's exact ps identity");
    assert.notEqual(start.state, "terminal", "an unverified child PID is not proof of manager loss");
    assert.equal(Object.hasOwn(start, "group"), false);
    const providerPid = Number(fs.readFileSync(fakeProvider.ready, "utf8").trim());
    worker = processIdentity(providerPid);
    const managerPid = Number(fs.readFileSync(shim.hidden, "utf8").trim());
    manager = processIdentity(managerPid);
    const state = readRuntime(root, start.runtime_id);
    assert.ok(worker && workerIdentityMatches(worker), "provider is physically active even if the parent has not read back its provider record yet");
    assert.ok(manager && workerIdentityMatches(manager), "the exact managed-session-manager remains alive");
    assert.equal(workerIdentityMatches(worker), true);
    assert.equal(workerIdentityMatches(manager), true);
  } finally {
    process.env.PATH = originalPath;
    if (start) {
      try { guardian = JSON.parse(fs.readFileSync(path.join(root, start.runtime_id, ".guardian", "owner.json"), "utf8")); } catch {}
    }
    if (guardian && workerIdentityMatches(guardian)) { try { process.kill(guardian.pid, "SIGKILL"); } catch {} }
    if (manager && workerIdentityMatches(manager)) { try { process.kill(manager.pid, "SIGKILL"); } catch {} }
    if (worker && workerIdentityMatches(worker)) { try { process.kill(-worker.pid, "SIGKILL"); } catch {} }
    for (let attempt = 0; attempt < 100 && guardian && workerIdentityMatches(guardian); attempt += 1) await delay(10);
    for (let attempt = 0; attempt < 100 && manager && workerIdentityMatches(manager); attempt += 1) await delay(10);
    for (let attempt = 0; attempt < 100 && worker && workerIdentityMatches(worker); attempt += 1) await delay(10);
    await removeTempTree(root);
  }
});

test("managed manager loss stays nonterminal until a SIGTERM-ignoring worker is gone", async () => {
  const root = temp(); const material = source(root); const fakeProvider = sigtermIgnoringProvider(root);
  const value = config(root, [material], { kimi: provider(fakeProvider.command) }); const broker = new Broker(value);
  const configPath = path.join(root, "config.json"); fs.writeFileSync(configPath, JSON.stringify(value));
  const cliStatus = async (runtimeId) => {
    const result = await callCli(["status", `--config=${configPath}`, `--runtime-id=${runtimeId}`]);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  let runtimeId = null; let manager = null; let worker = null; let guardian = null;

  try {
    const start = broker.startManaged(request(material.attachment), "manager-lost-sigterm-ignored"); runtimeId = start.runtime_id;
    let state;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      state = readRuntime(root, runtimeId);
      if (state.managed.operations[0].manager && state.providers.kimi?.worker && state.providers.kimi.status === "running" && fs.existsSync(fakeProvider.ready)) break;
      await delay(10);
    }
    manager = state.managed.operations[0].manager; worker = state.providers.kimi.worker;
    assert.ok(worker && workerIdentityMatches(worker));
    assert.equal(process.kill(manager.pid, "SIGTERM"), true);
    for (let attempt = 0; attempt < 100 && workerIdentityMatches(manager); attempt += 1) await delay(10);
    assert.equal(workerIdentityMatches(manager), false, "manager SIGTERM should be confirmed before checking provider cleanup");

    let duringCleanup;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // Each call launches a fresh CLI process. Its in-memory escalation
      // state disappears on exit; the existing detached guardian must own
      // the TERM -> KILL window across these status invocations.
      duringCleanup = await cliStatus(runtimeId);
      state = readRuntime(root, runtimeId);
      if (state.providers.kimi.cleanup_status === "cleanup_pending") break;
      await delay(10);
    }
    assert.equal(duringCleanup.state, "running", JSON.stringify({ response: duringCleanup, provider: state.providers.kimi, worker_alive: workerIdentityMatches(worker) }));
    assert.equal(workerIdentityMatches(worker), true);
    assert.equal(state.providers.kimi.status, "running");
    assert.equal(state.providers.kimi.orphan, true);
    assert.equal(state.providers.kimi.cleanup_status, "cleanup_pending");
    const guardianPath = path.join(root, runtimeId, ".guardian", "owner.json");
    guardian = JSON.parse(fs.readFileSync(guardianPath, "utf8"));
    assert.equal(workerIdentityMatches(guardian), true, "existing guardian remains alive to own escalation");

    await delay(250);
    duringCleanup = await cliStatus(runtimeId);
    assert.equal(duringCleanup.state, "running");
    assert.equal(workerIdentityMatches(worker), true, "worker must survive the SIGTERM grace period");

    const deadline = Date.now() + 12_000; let terminalResult = null;
    while (Date.now() < deadline) {
      const current = await cliStatus(runtimeId);
      if (current.state === "terminal") {
        assert.equal(workerIdentityMatches(worker), false, "terminal manager-loss result must follow exact worker exit");
        terminalResult = current; break;
      }
      assert.equal(current.state, "running");
      await delay(50);
    }
    assert.ok(terminalResult, "SIGKILL escalation should eventually let manager-loss cleanup finish");
    assert.equal(workerIdentityMatches(worker), false);
    assert.equal(terminalResult.group.providers[0].error.code, "SESSION_MANAGER_LOST");
    state = readRuntime(root, runtimeId);
    assert.equal(state.providers.kimi.status, "failed");
    assert.equal(state.providers.kimi.cleanup_status, "confirmed");
    for (let attempt = 0; attempt < 150 && workerIdentityMatches(guardian); attempt += 1) await delay(10);
    assert.equal(workerIdentityMatches(guardian), false, "guardian exits after confirmed worker cleanup");
  } finally {
    if (manager && workerIdentityMatches(manager)) process.kill(manager.pid, "SIGKILL");
    if (worker && workerIdentityMatches(worker)) process.kill(worker.pid, "SIGKILL");
    if (runtimeId) {
      const guardianPath = path.join(root, runtimeId, ".guardian", "owner.json");
      try { guardian = JSON.parse(fs.readFileSync(guardianPath, "utf8")); } catch { guardian = null; }
      for (let attempt = 0; attempt < 150 && guardian && workerIdentityMatches(guardian); attempt += 1) await delay(10);
      if (guardian && workerIdentityMatches(guardian)) process.kill(guardian.pid, "SIGKILL");
      for (let attempt = 0; attempt < 100 && worker && workerIdentityMatches(worker); attempt += 1) await delay(10);
      for (let attempt = 0; attempt < 100 && manager && workerIdentityMatches(manager); attempt += 1) await delay(10);
      for (let attempt = 0; attempt < 100 && guardian && workerIdentityMatches(guardian); attempt += 1) await delay(10);
      for (let attempt = 0; attempt < 100 && fs.existsSync(path.join(root, runtimeId, ".guardian")); attempt += 1) await delay(10);
    }
    await removeTempTree(root);
  }
});

test("expiry cleanup retains an orphan directory while its exact worker is cleanup-pending", async () => {
  const root = temp(); const fakeProvider = sigtermIgnoringProvider(root);
  const runtime = createRuntime(root, 24, "codex"); let worker = null; let guardian = null;

  try {
    const child = spawn(fakeProvider.command, [], { detached: true, stdio: "ignore" }); child.unref();
    worker = processIdentity(child.pid);
    for (let attempt = 0; attempt < 100 && (!workerIdentityMatches(worker) || !fs.existsSync(fakeProvider.ready)); attempt += 1) await delay(10);
    assert.ok(worker && workerIdentityMatches(worker));
    updateRuntime(root, runtime.runtime_id, (state) => ({
      ...state,
      expires_at_ms: 0,
      owner: { ...currentOwnerIdentity(), pid: 999_999_999, started: "confirmed-dead-owner", started_at_ms: 1 },
      providers: { kimi: { provider: "kimi", status: "running", pid: worker.pid, worker, started_at_ms: Date.now(), process_alive_at_ms: Date.now(), last_progress_at_ms: null } },
    }));
    assert.equal(ensureRuntimeGuardian(root, runtime.runtime_id), true);

    let removed = cleanup(root, 24);
    assert.equal(removed.includes(runtime.runtime_id), false);
    let state = readRuntime(root, runtime.runtime_id);
    assert.equal(state.providers.kimi.status, "running");
    assert.equal(state.providers.kimi.cleanup_status, "cleanup_pending");
    assert.equal(workerIdentityMatches(worker), true);
    guardian = JSON.parse(fs.readFileSync(path.join(root, runtime.runtime_id, ".guardian", "owner.json"), "utf8"));
    assert.equal(workerIdentityMatches(guardian), true);

    await delay(250);
    removed = cleanup(root, 24);
    assert.equal(removed.includes(runtime.runtime_id), false, "TTL cannot remove the runtime before exact worker exit");
    assert.equal(fs.existsSync(path.join(root, runtime.runtime_id, "state.json")), true);
    assert.equal(workerIdentityMatches(worker), true);

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && workerIdentityMatches(worker)) await delay(50);
    assert.equal(workerIdentityMatches(worker), false, "owner-loss guardian should escalate TERM to KILL");
    reapRuntimeIfOwnerDead(root, runtime.runtime_id);
    state = readRuntime(root, runtime.runtime_id);
    assert.equal(state.providers.kimi.status, "failed");
    assert.equal(state.providers.kimi.cleanup_status, "confirmed");
    for (let attempt = 0; attempt < 150 && guardian && workerIdentityMatches(guardian); attempt += 1) await delay(10);
    assert.equal(workerIdentityMatches(guardian), false, "guardian should stop after confirmed cleanup");
    removed = cleanup(root, 24);
    assert.equal(removed.includes(runtime.runtime_id), true, "expired runtime can be removed after cleanup is confirmed");
  } finally {
    if (worker && workerIdentityMatches(worker)) process.kill(worker.pid, "SIGKILL");
    if (guardian && workerIdentityMatches(guardian)) process.kill(guardian.pid, "SIGKILL");
    for (let attempt = 0; attempt < 100 && worker && workerIdentityMatches(worker); attempt += 1) await delay(10);
    for (let attempt = 0; attempt < 100 && guardian && workerIdentityMatches(guardian); attempt += 1) await delay(10);
    for (let attempt = 0; attempt < 100 && fs.existsSync(path.join(root, runtime.runtime_id, ".guardian")); attempt += 1) await delay(10);
    await removeTempTree(root);
  }
});

test("expired cleanup preserves a parsed runtime when orphan reaper persistence fails", async () => {
  const root = temp(); const fakeProvider = sigtermIgnoringProvider(root); const runtime = createRuntime(root, 24, "codex");
  let worker = null; const statePath = path.join(root, runtime.runtime_id, "state.json"); const originalRenameSync = fs.renameSync;
  try {
    const child = spawn(fakeProvider.command, [], { detached: true, stdio: "ignore" }); child.unref();
    worker = processIdentity(child.pid);
    for (let attempt = 0; attempt < 100 && (!workerIdentityMatches(worker) || !fs.existsSync(fakeProvider.ready)); attempt += 1) await delay(10);
    assert.ok(worker && workerIdentityMatches(worker));
    updateRuntime(root, runtime.runtime_id, (state) => ({
      ...state,
      expires_at_ms: 0,
      owner: { ...currentOwnerIdentity(), pid: 999_999_999, started: "confirmed-dead-owner", started_at_ms: 1 },
      providers: { kimi: { provider: "kimi", status: "running", pid: worker.pid, worker, orphan: false, cleanup_status: "cleanup_pending", dispatch_status: "dispatched", started_at_ms: Date.now() } },
    }));

    fs.renameSync = function (source, destination, ...args) {
      if (path.resolve(String(destination)) === statePath) throw Object.assign(new Error("simulated runtime state write failure"), { code: "EIO" });
      return originalRenameSync.call(this, source, destination, ...args);
    };
    const removed = cleanup(root, -1); // force the stale-file fallback if the catch path permits deletion
    assert.equal(removed.includes(runtime.runtime_id), false, "a parsed live/pending runtime must survive a reaper write failure");
    assert.equal(fs.existsSync(statePath), true);
    assert.equal(readRuntime(root, runtime.runtime_id).providers.kimi.cleanup_status, "cleanup_pending");
    assert.equal(workerIdentityMatches(worker), true);
  } finally {
    fs.renameSync = originalRenameSync;
    if (worker && workerIdentityMatches(worker)) { try { process.kill(-worker.pid, "SIGKILL"); } catch {} }
    for (let attempt = 0; attempt < 100 && worker && workerIdentityMatches(worker); attempt += 1) await delay(10);
    await removeTempTree(root);
  }
});

test("manager loss preserves a completed sibling for v2 and v3 while marking only the live route orphaned", async () => {
  for (const protocol of ["workflowhub-result.v2", "workflowhub-result.v3"]) {
    const root = temp(); const material = source(root);
    const value = config(root, [material], {
      "claude-code": provider(fake),
      kimi: provider(slow),
    }, [["claude-code", "kimi"]]);
    const broker = new Broker(value);
    const review = request(material.attachment, "preserve completed sibling", null, ["claude-code", "kimi"]);
    review.required_result_protocol = protocol;
    review.review_mode = "single_round";
    const start = broker.startManaged(review, `manager-lost-sibling-${protocol}`);
    let state;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      state = readRuntime(root, start.runtime_id);
      if (state.providers["claude-code"]?.status === "completed" && state.providers.kimi?.status === "running") break;
      await delay(10);
    }
    assert.equal(state.providers["claude-code"]?.status, "completed");
    assert.equal(state.providers.kimi?.status, "running");
    const providerWorker = state.providers.kimi.worker;
    assert.ok(state.managed.operations[0].manager?.pid);
    assert.equal(process.kill(state.managed.operations[0].manager.pid, "SIGTERM"), true);
    let lost = null; const managerLossDeadline = Date.now() + 10_000;
    while (Date.now() < managerLossDeadline) {
      lost = broker.managedStatus(start.runtime_id);
      if (lost.state === "terminal") { assert.equal(workerIdentityMatches(providerWorker), false); break; }
      assert.equal(lost.state, "running"); await delay(25);
    }
    assert.ok(lost?.state === "terminal");
    const members = Object.fromEntries(lost.group.providers.map((item) => [item.identity?.provider ?? item.provider, item]));
    assert.equal(members["claude-code"].status, "completed");
    assert.equal(members.kimi.error.code, "SESSION_MANAGER_LOST");
    assert.equal(lost.group.outcome, protocol === "workflowhub-result.v2" ? "completed" : "partial");
    const reaped = readRuntime(root, start.runtime_id).providers.kimi;
    assert.equal(reaped.status, "failed");
    assert.equal(reaped.dispatch_status, "dispatched_unavailable");
    assert.equal(reaped.orphan, true);
    assert.equal(reaped.cleanup_status, "confirmed");
    assert.equal(workerIdentityMatches(providerWorker), false);
  }
});

test("manager loss publishes a terminal result from the operation snapshot when its job file is missing", async () => {
  const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slow) }); const broker = new Broker(value);
  let manager = null; let worker = null; let guardian = null; let runtimeId = null;

  try {
    const start = broker.startManaged(request(material.attachment), "manager-lost-job-missing"); runtimeId = start.runtime_id;
    let state;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      state = readRuntime(root, runtimeId);
      if (state.managed.operations[0].manager && state.providers.kimi?.worker && state.providers.kimi.status === "running") break;
      await delay(10);
    }
    const operation = state.managed.operations[0]; manager = operation.manager; worker = state.providers.kimi.worker;
    assert.ok(manager && workerIdentityMatches(manager));
    assert.ok(worker && workerIdentityMatches(worker));
    assert.equal(process.kill(manager.pid, "SIGTERM"), true);
    for (let attempt = 0; attempt < 100 && workerIdentityMatches(manager); attempt += 1) await delay(10);
    assert.equal(workerIdentityMatches(manager), false, "the exact manager identity is confirmed gone");
    fs.rmSync(path.join(root, runtimeId, "managed", "operations", operation.operation_id + ".json"));

    let terminalResult = null; let statusError = null; const until = Date.now() + 10_000;
    while (Date.now() < until) {
      try {
        const current = broker.managedStatus(runtimeId);
        if (current.state === "terminal") { terminalResult = current; break; }
        assert.equal(current.state, "running");
      } catch (error) { statusError = error; break; }
      await delay(25);
    }
    assert.equal(statusError, null, statusError?.message);
    assert.ok(terminalResult, "confirmed manager loss must reach a public terminal state without the private job file");
    assert.equal(workerIdentityMatches(worker), false, "the terminal state follows confirmed provider cleanup");
    assert.equal(terminalResult.group.providers[0].error.code, "SESSION_MANAGER_LOST");
    assert.equal(readRuntime(root, runtimeId).providers.kimi.cleanup_status, "confirmed");
  } finally {
    if (manager && workerIdentityMatches(manager)) process.kill(manager.pid, "SIGKILL");
    if (worker && workerIdentityMatches(worker)) { try { process.kill(-worker.pid, "SIGKILL"); } catch {} }
    if (runtimeId) {
      try { guardian = JSON.parse(fs.readFileSync(path.join(root, runtimeId, ".guardian", "owner.json"), "utf8")); } catch {}
    }
    if (guardian && workerIdentityMatches(guardian)) process.kill(guardian.pid, "SIGKILL");
    await removeTempTree(root);
  }
});

test("manager-loss terminal fallback rejects corrupt or identity-mismatched job snapshots", async () => {
  const cases = [
    { name: "corrupt-json", expectedCode: "MANAGED_JOB_INVALID", rewrite: () => "{\n" },
    { name: "runtime-id-mismatch", expectedCode: "MANAGED_JOB_IDENTITY_MISMATCH", rewrite: (job) => JSON.stringify({ ...job, runtime_id: "different-runtime" }) },
    { name: "operation-id-mismatch", expectedCode: "MANAGED_JOB_IDENTITY_MISMATCH", rewrite: (job) => JSON.stringify({ ...job, operation_id: "different-operation" }) },
  ];
  const outcomes = [];

  for (const scenario of cases) {
    const root = temp(); const material = source(root); const value = config(root, [material], { kimi: provider(slow) }); const broker = new Broker(value);
    let manager = null; let worker = null; let guardian = null; let runtimeId = null;
    const killIfStillMatching = (identity, pid = identity?.pid) => {
      if (!identity || !workerIdentityMatches(identity)) return;
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if (error?.code !== "ESRCH") throw error; }
    };
    try {
      const start = broker.startManaged(request(material.attachment), "manager-lost-job-" + scenario.name); runtimeId = start.runtime_id;
      let state;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        state = readRuntime(root, runtimeId);
        if (state.managed.operations[0].manager && state.providers.kimi?.worker && state.providers.kimi.status === "running") break;
        await delay(10);
      }
      const operation = state.managed.operations[0]; manager = operation.manager; worker = state.providers.kimi.worker;
      assert.ok(manager && workerIdentityMatches(manager));
      assert.ok(worker && workerIdentityMatches(worker));
      assert.equal(process.kill(manager.pid, "SIGTERM"), true);
      for (let attempt = 0; attempt < 100 && workerIdentityMatches(manager); attempt += 1) await delay(10);
      assert.equal(workerIdentityMatches(manager), false, "the exact manager identity is confirmed gone");

      const jobPath = path.join(root, runtimeId, "managed", "operations", operation.operation_id + ".json");
      assert.equal(fs.existsSync(jobPath), true, "the private job snapshot exists before corruption");
      const job = scenario.name === "corrupt-json" ? null : JSON.parse(fs.readFileSync(jobPath, "utf8"));
      fs.writeFileSync(jobPath, scenario.rewrite(job));

      let terminalResult = null; let statusError = null; const until = Date.now() + 10_000;
      while (Date.now() < until) {
        try {
          const current = broker.managedStatus(runtimeId);
          if (current.state === "terminal") { terminalResult = current; break; }
          assert.equal(current.state, "running");
        } catch (error) { statusError = error; break; }
        await delay(25);
      }
      outcomes.push({ name: scenario.name, expectedCode: scenario.expectedCode, actualCode: statusError?.code ?? null, terminal: terminalResult !== null, operationState: readRuntime(root, runtimeId).managed.operations[0].state });
    } finally {
      killIfStillMatching(manager);
      killIfStillMatching(worker, worker && -worker.pid);
      if (runtimeId) {
        try { guardian = JSON.parse(fs.readFileSync(path.join(root, runtimeId, ".guardian", "owner.json"), "utf8")); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      killIfStillMatching(guardian);
      await removeTempTree(root);
    }
  }

  assert.deepEqual(outcomes.map(({ actualCode }) => actualCode), cases.map(({ expectedCode }) => expectedCode), JSON.stringify(outcomes));
  assert.deepEqual(outcomes.map(({ terminal }) => terminal), [false, false, false], JSON.stringify(outcomes));
  assert.deepEqual(outcomes.map(({ operationState }) => operationState), ["running", "running", "running"], JSON.stringify(outcomes));
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
