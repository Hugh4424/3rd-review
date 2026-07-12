import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { JobStore } from "../../lib/v3/job-store.mjs";
import { createMaterial, createRequestId, RUNTIME_TTL_MS, sha256 } from "../../lib/v3/protocol.mjs";

function request(nonce = null) {
  return { protocol_version: 3, request_id: "44444444-4444-4444-8444-444444444444", nonce, round: 1, runtime_id: null, previous_receipt_hash: null, host_hint: { provider: "codex", backend: "cli", wrapper_hash: "test" }, material: createMaterial("bounded material"), contract_ref: "opaque://test/contract", force_tier: null, overrides: {} };
}

test("durable job store binds nonce, provider receipt, opaque private refs, and replay", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new JobStore({ runtimeRoot: root, now: () => 100 });
  const first = store.begin({ request: request(), config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" });
  const providerRoot = path.join(root, first.request.runtime_id, "kimi");
  mkdirSync(providerRoot, { recursive: true, mode: 0o700 });
  const raw = path.join(providerRoot, "raw.stdout");
  const diagnostic = path.join(providerRoot, "raw.stderr");
  writeFileSync(raw, "provider text", { mode: 0o600 });
  writeFileSync(diagnostic, "provider diagnostic", { mode: 0o600 });
  const publicProvider = store.commitProvider({
    runtime_id: first.request.runtime_id, provider: "kimi", request: first.request,
    config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}", profile_hash: `sha256:${"b".repeat(64)}`,
    result: { execution_eligible: true, session_id: "kimi_session", persisted: true, raw_ref: raw, diagnostic_ref: diagnostic, result_text: "final review text", metrics: { elapsed_ms: 3, input_bytes: 16, output_bytes: 13 } },
  });
  const result = { protocol_version: 3, request_id: first.request.request_id, nonce: first.request.nonce, runtime_id: first.request.runtime_id, providers: [publicProvider] };
  store.complete(first.request.runtime_id, result);
  assert.equal(publicProvider.raw_ref, undefined);
  assert.equal(publicProvider.receipt_ref, `private://${first.request.runtime_id}/kimi/receipt?round=1`);
  assert.equal(publicProvider.result_ref, `private://${first.request.runtime_id}/kimi/result?round=1`);
  assert.equal(store.readPrivate({ runtime_id: first.request.runtime_id, provider: "kimi", nonce: first.request.nonce, ref: "raw" }), "provider text");
  assert.equal(store.readPrivate({ runtime_id: first.request.runtime_id, provider: "kimi", nonce: first.request.nonce, ref: "receipt" }).session_id, "kimi_session");
  assert.equal(store.readPrivate({ runtime_id: first.request.runtime_id, provider: "kimi", nonce: first.request.nonce, ref: "result", round: 1 }), "final review text");
  assert.throws(() => store.readPrivate({ runtime_id: first.request.runtime_id, provider: "unknown", nonce: first.request.nonce, ref: "raw" }), { code: "BINDING_MISMATCH" });
  assert.deepEqual(store.begin({ request: request(first.request.nonce), config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" }).job.result, result);
  assert.throws(() => store.begin({ request: request("different_nonce"), config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" }), { code: "REPLAY_DETECTED" });
  assert.throws(() => store.readPrivate({ runtime_id: first.request.runtime_id, provider: "kimi", nonce: "different_nonce", ref: "raw" }), { code: "BINDING_MISMATCH" });
});

test("expired terminal runtimes are removed automatically but their request id stays expired", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-store-gc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 100;
  const store = new JobStore({ runtimeRoot: root, now: () => now });
  const first = store.begin({ request: request(), config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" });
  store.complete(first.request.runtime_id, { request_id: first.request.request_id });
  now += RUNTIME_TTL_MS + 1;
  assert.deepEqual(store.gcExpired(), [first.request.runtime_id]);
  assert.throws(() => store.begin({ request: request(first.request.nonce), config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" }), { code: "NONCE_EXPIRED" });
});

test("expired runtimes with an orphaned active record are reclaimed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-store-orphan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 100;
  const store = new JobStore({ runtimeRoot: root, now: () => now });
  const first = store.begin({ request: request(), config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" });
  const active = store.activePath(first.request.runtime_id, "kimi");
  mkdirSync(path.dirname(active), { recursive: true, mode: 0o700 });
  writeFileSync(active, JSON.stringify({ terminal: false, pid: -1 }), { mode: 0o600 });
  now += RUNTIME_TTL_MS + 1;
  assert.deepEqual(store.gcExpired(), [first.request.runtime_id]);
});

test("an exclusive request reservation reports an active creator instead of replacing its index", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-store-reserve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pending = request();
  const index = path.join(root, ".3rd-review-requests", `${sha256(pending.request_id).slice(7)}.json`);
  mkdirSync(path.dirname(index), { recursive: true, mode: 0o700 });
  writeFileSync(index, `${JSON.stringify({ creating: true, pid: process.pid, created_at_ms: Date.now() })}\n`, { mode: 0o600 });
  const store = new JobStore({ runtimeRoot: root });
  assert.throws(() => store.begin({ request: pending, config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" }), { code: "DUPLICATE_ACTIVE_REQUEST" });
});

test("a stale exclusive request reservation is reclaimed instead of blocking its request id forever", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-store-reclaim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pending = request();
  const index = path.join(root, ".3rd-review-requests", `${sha256(pending.request_id).slice(7)}.json`);
  mkdirSync(path.dirname(index), { recursive: true, mode: 0o700 });
  writeFileSync(index, '{"creating":true,"pid":-1,"created_at_ms":1}\n', { mode: 0o600 });
  const store = new JobStore({ runtimeRoot: root });
  assert.equal(store.begin({ request: pending, config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" }).existing, false);
});

test("one runtime-wide lock prevents two distinct continuation request ids from starting the same round", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-store-round-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configHash = `sha256:${"a".repeat(64)}`;
  const store = new JobStore({ runtimeRoot: root });
  const first = store.begin({ request: request(), config_hash: configHash, config_snapshot: "{}" });
  const providerRoot = path.join(root, first.request.runtime_id, "kimi");
  mkdirSync(providerRoot, { recursive: true, mode: 0o700 });
  const raw = path.join(providerRoot, "initial.stdout");
  writeFileSync(raw, "initial", { mode: 0o600 });
  store.commitProvider({
    runtime_id: first.request.runtime_id, provider: "kimi", request: first.request, config_hash: configHash, config_snapshot: "{}", profile_hash: `sha256:${"b".repeat(64)}`,
    result: { execution_eligible: true, session_id: "kimi-session", persisted: true, raw_ref: raw, result_text: "initial", metrics: {} },
  });
  store.complete(first.request.runtime_id, { request_id: first.request.request_id });
  const prior = store.readPrivate({ runtime_id: first.request.runtime_id, provider: "kimi", nonce: first.request.nonce, ref: "receipt", round: 1 });
  const continuation = (request_id) => ({
    ...request(first.request.nonce), request_id, runtime_id: first.request.runtime_id, round: 2,
    material: createMaterial("delta"), previous_receipt_hash: null, previous_receipts: { kimi: prior.receipt_hash },
  });
  assert.throws(() => store.beginContinuation({ request: { ...continuation(createRequestId()), host_hint: { provider: "kimi", backend: "cli", wrapper_hash: "test" } }, config_hash: configHash }), { code: "BINDING_MISMATCH" });
  assert.equal(store.beginContinuation({ request: continuation(createRequestId()), config_hash: configHash }).existing, false);
  assert.equal(store.readJob(first.request.runtime_id).result, null);
  assert.throws(
    () => store.beginContinuation({ request: continuation(createRequestId()), config_hash: configHash }),
    { code: "DUPLICATE_ACTIVE_REQUEST" },
  );
});

test("a crashed continuation returns an explicit interrupted result instead of the prior round", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-store-interrupted-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configHash = `sha256:${"a".repeat(64)}`;
  const store = new JobStore({ runtimeRoot: root });
  const first = store.begin({ request: request(), config_hash: configHash, config_snapshot: "{}" });
  const providerRoot = path.join(root, first.request.runtime_id, "kimi"); mkdirSync(providerRoot, { recursive: true, mode: 0o700 });
  const raw = path.join(providerRoot, "initial.stdout"); writeFileSync(raw, "initial", { mode: 0o600 });
  store.commitProvider({ runtime_id: first.request.runtime_id, provider: "kimi", request: first.request, config_hash: configHash, config_snapshot: "{}", profile_hash: `sha256:${"b".repeat(64)}`, result: { execution_eligible: true, session_id: "kimi-session", persisted: true, raw_ref: raw, result_text: "initial", metrics: {} } });
  store.complete(first.request.runtime_id, { request_id: first.request.request_id, old: true });
  const prior = store.readPrivate({ runtime_id: first.request.runtime_id, provider: "kimi", nonce: first.request.nonce, ref: "receipt" });
  const second = { ...request(first.request.nonce), request_id: createRequestId(), runtime_id: first.request.runtime_id, round: 2, material: createMaterial("delta"), previous_receipt_hash: null, previous_receipts: { kimi: prior.receipt_hash } };
  store.beginContinuation({ request: second, config_hash: configHash });
  const lock = path.join(root, first.request.runtime_id, ".3rd-review-round.lock");
  writeFileSync(lock, JSON.stringify({ request_id: second.request_id, round: 2, pid: -1 }), { mode: 0o600 });
  const replay = store.beginContinuation({ request: second, config_hash: configHash });
  assert.equal(replay.existing, true);
  assert.equal(replay.job.result.stop_reason, "continuation_interrupted");
  assert.notEqual(replay.job.result.old, true);
});
