import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AttemptLocks, RecoveryLedger, gcExpiredRuntimes } from "../../lib/v3/recovery.mjs";
import { RUNTIME_TTL_MS } from "../../lib/v3/protocol.mjs";

const hash = (character) => `sha256:${character.repeat(64)}`;
const binding = { config_hash: hash("a"), profile_hash: hash("b"), material_hash: hash("c") };

function runtime(t, id) {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-recovery-"));
  const runtime_path = path.join(root, id);
  mkdirSync(runtime_path);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return runtime_path;
}

function record(ledger, t, value) {
  const runtime_path = runtime(t, value.runtime_id);
  ledger.record({ ...value, runtime_path });
  return runtime_path;
}

test("a provider can resume only its own matching session once and never silently fresh", async (t) => {
  const ledger = new RecoveryLedger({ now: () => 1_000 });
  const runtime_path = record(ledger, t, { runtime_id: "runtime_a", provider: "kimi", session_id: "kimi_session", ...binding });
  assert.equal(statSync(runtime_path).mode & 0o777, 0o700);
  let calls = 0;
  const first = await ledger.resumeOnce({ runtime_id: "runtime_a", provider: "kimi", session_id: "kimi_session", ...binding, resume_input: "repair JSON" }, async (context) => {
    calls += 1;
    assert.equal(context.resume_input, "repair JSON");
    return { execution_eligible: true, session_id: "kimi_session" };
  });
  assert.equal(first.execution_eligible, true);
  assert.equal(calls, 1);
  ledger.record({ runtime_id: "runtime_a", provider: "kimi", session_id: "kimi_session", runtime_path, ...binding });
  const restarted = new RecoveryLedger();
  restarted.record({ runtime_id: "runtime_a", provider: "kimi", session_id: "kimi_session", runtime_path, ...binding });
  await assert.rejects(restarted.resumeOnce({ runtime_id: "runtime_a", provider: "kimi", session_id: "kimi_session", ...binding, resume_input: "again" }, async () => ({})), { code: "CONTINUATION_FAILED" });
  await assert.rejects(ledger.resumeOnce({ runtime_id: "runtime_a", provider: "codex", session_id: "kimi_session", ...binding, resume_input: "wrong provider" }, async () => ({})), { code: "CONTINUATION_FAILED" });
});

test("one recovery is allowed only for invalid JSON with an explicit native session", async (t) => {
  const ledger = new RecoveryLedger();
  record(ledger, t, { runtime_id: "runtime_b", provider: "claude-code", session_id: "claude_session", ...binding });
  await assert.rejects(ledger.repairOnce({ runtime_id: "runtime_b", provider: "claude-code", error_code: "INVALID_JSON", ...binding, resume_input: "missing session" }, async () => ({})), { code: "CONTINUATION_FAILED" });
  const repaired = await ledger.repairOnce({ runtime_id: "runtime_b", provider: "claude-code", session_id: "claude_session", error_code: "INVALID_JSON", ...binding, resume_input: "Return only valid JSON." }, async () => ({ execution_eligible: true, session_id: "claude_session" }));
  assert.equal(repaired.execution_eligible, true);
  await assert.rejects(ledger.repairOnce({ runtime_id: "runtime_b", provider: "claude-code", session_id: "claude_session", error_code: "INVALID_JSON", ...binding, resume_input: "again" }, async () => ({})), { code: "CONTINUATION_FAILED" });
  await assert.rejects(ledger.repairOnce({ runtime_id: "runtime_b", provider: "claude-code", session_id: "claude_session", error_code: "OUTPUT_LIMIT", ...binding, resume_input: "wrong" }, async () => ({})), { code: "CONTINUATION_FAILED" });
});

test("continuation rejects changed material or expired state before the runner", async (t) => {
  let now = 1_000;
  const ledger = new RecoveryLedger({ now: () => now });
  record(ledger, t, { runtime_id: "runtime_c", provider: "kimi", session_id: "s", ...binding });
  let calls = 0;
  await assert.rejects(ledger.resumeOnce({ runtime_id: "runtime_c", provider: "kimi", session_id: "s", config_hash: binding.config_hash, profile_hash: binding.profile_hash, material_hash: hash("d"), resume_input: "resume" }, async () => { calls += 1; return {}; }), { code: "BINDING_MISMATCH" });
  assert.equal(calls, 0);
  now += RUNTIME_TTL_MS + 1;
  await assert.rejects(ledger.resumeOnce({ runtime_id: "runtime_c", provider: "kimi", session_id: "s", ...binding, resume_input: "resume" }, async () => { calls += 1; return {}; }), { code: "CONTINUATION_FAILED" });
  assert.equal(calls, 0);
});

test("one recovery budget covers resume and JSON repair, and active continuation is locked", async (t) => {
  const ledger = new RecoveryLedger();
  record(ledger, t, { runtime_id: "runtime_d", provider: "opencode", session_id: "open_session", ...binding });
  let releaseRun;
  const pending = ledger.resumeOnce({ runtime_id: "runtime_d", provider: "opencode", session_id: "open_session", ...binding, resume_input: "continue" }, async () => new Promise((resolve) => { releaseRun = () => resolve({ execution_eligible: false }); }));
  await assert.rejects(ledger.repairOnce({ runtime_id: "runtime_d", provider: "opencode", session_id: "open_session", error_code: "INVALID_JSON", ...binding, resume_input: "repair" }, async () => ({})), { code: "DUPLICATE_ACTIVE_REQUEST" });
  releaseRun();
  await pending;
  await assert.rejects(ledger.repairOnce({ runtime_id: "runtime_d", provider: "opencode", session_id: "open_session", error_code: "INVALID_JSON", ...binding, resume_input: "repair" }, async () => ({})), { code: "CONTINUATION_FAILED" });
});

test("a second broker instance cannot start a continuation while the private lease is active", async (t) => {
  const first = new RecoveryLedger();
  const runtime_path = record(first, t, { runtime_id: "runtime_lease", provider: "kimi", session_id: "lease_session", ...binding });
  const second = new RecoveryLedger();
  second.record({ runtime_id: "runtime_lease", provider: "kimi", session_id: "lease_session", runtime_path, ...binding });
  let releaseRun;
  const pending = first.resumeOnce({ runtime_id: "runtime_lease", provider: "kimi", session_id: "lease_session", ...binding, resume_input: "continue" }, async () => new Promise((resolve) => { releaseRun = () => resolve({ execution_eligible: false }); }));
  await assert.rejects(second.resumeOnce({ runtime_id: "runtime_lease", provider: "kimi", session_id: "lease_session", ...binding, resume_input: "duplicate" }, async () => ({})), { code: "DUPLICATE_ACTIVE_REQUEST" });
  releaseRun();
  await pending;
});

test("successful recovery alone refreshes durable runtime expiry", async (t) => {
  let now = 1_000;
  const ledger = new RecoveryLedger({ now: () => now });
  const runtime_path = record(ledger, t, { runtime_id: "runtime_e", provider: "kimi", session_id: "k", ...binding });
  now += 100;
  await ledger.resumeOnce({ runtime_id: "runtime_e", provider: "kimi", session_id: "k", ...binding, resume_input: "resume" }, async () => ({ execution_eligible: true }));
  assert.equal(JSON.parse(readFileSync(path.join(runtime_path, ".3rd-review-runtime.json"), "utf8")).expires_at_ms, now + RUNTIME_TTL_MS);

  const failed_path = record(ledger, t, { runtime_id: "runtime_f", provider: "kimi", session_id: "k2", ...binding });
  const failedExpiry = JSON.parse(readFileSync(path.join(failed_path, ".3rd-review-runtime.json"), "utf8")).expires_at_ms;
  now += 100;
  await ledger.resumeOnce({ runtime_id: "runtime_f", provider: "kimi", session_id: "k2", ...binding, resume_input: "resume" }, async () => ({ execution_eligible: false }));
  assert.equal(JSON.parse(readFileSync(path.join(failed_path, ".3rd-review-runtime.json"), "utf8")).expires_at_ms, failedExpiry);
});

test("active duplicate lock is explicit and terminal release permits a new operation", () => {
  const locks = new AttemptLocks();
  const release = locks.acquire("request:provider");
  assert.throws(() => locks.acquire("request:provider"), { code: "DUPLICATE_ACTIVE_REQUEST" });
  release();
  assert.doesNotThrow(() => locks.acquire("request:provider"));
});

test("recovery rejects symlink runtime roots and state files before reading or chmodding them", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-symlink-"));
  const real = path.join(root, "real");
  const linked = path.join(root, "linked");
  mkdirSync(real);
  symlinkSync(real, linked);
  const ledger = new RecoveryLedger();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => ledger.record({ runtime_id: "runtime_link", provider: "kimi", session_id: "s", runtime_path: linked, ...binding }), { code: "BINDING_MISMATCH" });
  ledger.record({ runtime_id: "runtime_real", provider: "kimi", session_id: "s", runtime_path: real, ...binding });
  rmSync(path.join(real, ".3rd-review-recovery-kimi.json"));
  symlinkSync("/dev/null", path.join(real, ".3rd-review-recovery-kimi.json"));
  assert.throws(() => new RecoveryLedger().record({ runtime_id: "runtime_real", provider: "kimi", session_id: "s", runtime_path: real, ...binding }), { code: "BINDING_MISMATCH" });
});

test("runtime GC removes only expired inactive roots with V3 runtime expiry", () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-gc-"));
  const now = Date.now();
  try {
    for (const [name, expires_at_ms] of [["expired", now - 1], ["active", now - 1], ["fresh", now + 1]]) {
      const directory = path.join(root, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, ".3rd-review-runtime.json"), JSON.stringify({ last_success_at_ms: 1, expires_at_ms }), { mode: 0o600 });
    }
    assert.deepEqual(gcExpiredRuntimes({ runtime_root: root, now, is_active: (id) => id === "active" }), ["expired"]);
    assert.deepEqual(gcExpiredRuntimes({ runtime_root: root, now, is_active: () => false }), ["active"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime GC retains an expired runtime while a live private lease exists", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-gc-lease-"));
  const runtime_path = path.join(root, "runtime_g");
  mkdirSync(runtime_path);
  const ledger = new RecoveryLedger({ now: () => 1_000 });
  ledger.record({ runtime_id: "runtime_g", provider: "kimi", session_id: "g", runtime_path, ...binding });
  writeFileSync(path.join(runtime_path, ".3rd-review-runtime.json"), JSON.stringify({ last_success_at_ms: 1, expires_at_ms: 1 }), { mode: 0o600 });
  let releaseRun;
  try {
    const pending = ledger.resumeOnce({ runtime_id: "runtime_g", provider: "kimi", session_id: "g", ...binding, resume_input: "continue" }, async () => new Promise((resolve) => { releaseRun = () => resolve({ execution_eligible: false }); }));
    assert.deepEqual(gcExpiredRuntimes({ runtime_root: root, now: 2 }), []);
    releaseRun();
    await pending;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
