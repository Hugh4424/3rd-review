import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { JobStore } from "../../lib/v3/job-store.mjs";
import { createMaterial } from "../../lib/v3/protocol.mjs";

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
    result: { execution_eligible: true, session_id: "kimi_session", persisted: true, raw_ref: raw, diagnostic_ref: diagnostic, metrics: { elapsed_ms: 3, input_bytes: 16, output_bytes: 13 } },
  });
  const result = { protocol_version: 3, request_id: first.request.request_id, nonce: first.request.nonce, runtime_id: first.request.runtime_id, providers: [publicProvider] };
  store.complete(first.request.runtime_id, result);
  assert.equal(publicProvider.raw_ref, undefined);
  assert.equal(publicProvider.receipt_ref, `private://${first.request.runtime_id}/kimi/receipt`);
  assert.equal(store.readPrivate({ runtime_id: first.request.runtime_id, provider: "kimi", nonce: first.request.nonce, ref: "raw" }), "provider text");
  assert.equal(store.readPrivate({ runtime_id: first.request.runtime_id, provider: "kimi", nonce: first.request.nonce, ref: "receipt" }).session_id, "kimi_session");
  assert.deepEqual(store.begin({ request: request(first.request.nonce), config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" }).job.result, result);
  assert.throws(() => store.begin({ request: request("different_nonce"), config_hash: `sha256:${"a".repeat(64)}`, config_snapshot: "{}" }), { code: "REPLAY_DETECTED" });
  assert.throws(() => store.readPrivate({ runtime_id: first.request.runtime_id, provider: "kimi", nonce: "different_nonce", ref: "raw" }), { code: "BINDING_MISMATCH" });
});
