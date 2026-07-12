import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LiveBroker } from "../../lib/v3/live-broker.mjs";
import { createMaterial, createRequestId } from "../../lib/v3/protocol.mjs";

const config = {
  config_hash: `sha256:${"a".repeat(64)}`,
  config: {
    defaults: { deadline_seconds: null, max_output_bytes: 1024, max_input_bytes: 1024 },
    tiers: [["alpha", "beta"], ["gamma"]],
    providers: Object.fromEntries(["alpha", "beta", "gamma"].map((id) => [id, { id, enabled: true, command: process.execPath, model: null, effort: null, thinking: null, auth_env: [], profile: null }])),
  },
};

test("live broker joins tier routing, direct supervisor output, parsing, and partial success", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-live-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = path.join(root, "raw");
  writeFileSync(raw, "raw");
  const stderr = path.join(root, "stderr");
  writeFileSync(stderr, "native session");
  const calls = [];
  const supervisor = { runtimeRoot: root, async run(plan) { calls.push(plan.provider); return { status: "completed", persisted: true, stdout_path: raw, stderr_path: stderr, output_bytes: 3, started_at_ms: 1, finished_at_ms: 2 }; } };
  const adapters = { get(id) { return {
    buildStart: () => ({ command: process.execPath, argv: [], cwd: root, env: {}, input: null }),
    parse: (combined) => id === "alpha" ? { text: null, session_id: null, error_code: "INVALID_JSON" } : { text: "ok", session_id: `${id}_session`, error_code: null },
  }; } };
  const request = { protocol_version: 3, request_id: "11111111-1111-4111-8111-111111111111", nonce: null, round: 1, runtime_id: null, previous_receipt_hash: null, host_hint: { provider: "codex", backend: "codex-cli", wrapper_hash: "test" }, material: createMaterial("review"), contract_ref: "opaque://test/contract", force_tier: null, overrides: {} };
  const store = {
    gcExpired() { return []; },
    begin({ request: input }) { return { existing: false, request: { ...input, nonce: "test_nonce", runtime_id: "test_runtime" } }; },
    commitProvider({ provider, result: output }) { return { id: provider, ...output, runtime_id: "test_runtime", receipt_ref: "private://test_runtime/beta/receipt", diagnostic_ref: "private://test_runtime/beta/diagnostic" }; },
    complete() {},
  };
  const result = await new LiveBroker({ supervisor, adapters, recovery: { record() {} }, store }).run({ request, config, host_provider: "alpha", host_verified: true, options: { cwd: root } });
  assert.deepEqual(calls, ["beta"]);
  assert.equal(result.stop_reason, "execution_eligible");
  assert.equal(result.providers[0].id, "alpha");
  assert.equal(result.providers[0].error_code, "SAME_SOURCE");
  assert.equal(result.providers[1].session_id, "beta_session");
});

test("live broker rejects an oversized request before it can start a provider", async () => {
  const supervisor = { async run() { throw new Error("must not start"); } };
  const request = { protocol_version: 3, request_id: "22222222-2222-4222-8222-222222222222", nonce: null, round: 1, runtime_id: null, previous_receipt_hash: null, host_hint: { provider: "codex", backend: "codex-cli", wrapper_hash: "test" }, material: createMaterial("too large"), contract_ref: "opaque://test/contract", force_tier: null, overrides: {} };
  const constrained = structuredClone(config);
  constrained.config.defaults.max_input_bytes = 1;
  await assert.rejects(new LiveBroker({ supervisor }).run({ request, config: constrained, options: { cwd: "/tmp" } }), { code: "INPUT_TOO_LARGE" });
});

test("live broker resumes only the recorded provider session and consumes the single recovery budget", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-live-resume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const supervisor = {
    runtimeRoot: root,
    async run(plan) {
      const directory = path.join(root, plan.runtime_id, plan.provider);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stdout = path.join(directory, `${plan.attempt_id}.stdout`);
      const stderr = path.join(directory, `${plan.attempt_id}.stderr`);
      writeFileSync(stdout, plan.argv[0] === "resume" ? "resumed" : "initial", { mode: 0o600 });
      writeFileSync(stderr, "", { mode: 0o600 });
      return { status: "completed", persisted: true, stdout_path: stdout, stderr_path: stderr, output_bytes: 7, started_at_ms: 1, finished_at_ms: 2 };
    },
  };
  const adapters = { get() { return {
    buildStart: () => ({ command: process.execPath, argv: ["start"], cwd: root, env: {}, input: null }),
    buildResume: ({ session_id, resume_input }) => ({ command: process.execPath, argv: ["resume", session_id, resume_input], cwd: root, env: {}, input: null }),
    parse: (output) => output.includes("resumed") ? { text: "continued", session_id: "native_session", error_code: null } : { text: "initial", session_id: "native_session", error_code: null },
  }; } };
  const request = { protocol_version: 3, request_id: "33333333-3333-4333-8333-333333333333", nonce: null, round: 1, runtime_id: null, previous_receipt_hash: null, host_hint: { provider: "host", backend: "test", wrapper_hash: "test" }, material: createMaterial("review"), contract_ref: "opaque://test/contract", force_tier: 0, overrides: {} };
  const broker = new LiveBroker({ supervisor, adapters });
  const initial = await broker.run({ request, config, options: { cwd: root } });
  const resumed = await broker.resume({ runtime_id: initial.runtime_id, provider_id: "alpha", session_id: "native_session", material_hash: request.material.input_hash, resume_input: "continue", config, options: { cwd: root } });
  assert.equal(resumed.execution_eligible, true);
  assert.equal(resumed.session_id, "native_session");
  await assert.rejects(broker.resume({ runtime_id: initial.runtime_id, provider_id: "alpha", session_id: "native_session", material_hash: request.material.input_hash, resume_input: "again", config, options: { cwd: root } }), { code: "CONTINUATION_FAILED" });
});

test("business continuation preserves each provider's immutable receipt lineage and final text", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-live-round-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const supervisor = {
    runtimeRoot: root,
    async run(plan) {
      const directory = path.join(root, plan.runtime_id, plan.provider);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stdout = path.join(directory, `${plan.attempt_id}.stdout`);
      const stderr = path.join(directory, `${plan.attempt_id}.stderr`);
      const operation = plan.argv[0];
      calls.push([plan.provider, operation, plan.argv.at(-1)]);
      writeFileSync(stdout, operation === "resume" ? `round2-${plan.provider}` : `round1-${plan.provider}`, { mode: 0o600 });
      writeFileSync(stderr, "", { mode: 0o600 });
      return { status: "completed", persisted: true, stdout_path: stdout, stderr_path: stderr, output_bytes: 16, started_at_ms: 1, finished_at_ms: 2 };
    },
  };
  const adapters = { get(id) { return {
    buildStart: () => ({ command: process.execPath, argv: ["start"], cwd: root, env: {}, input: null }),
    buildResume: ({ session_id, resume_input }) => ({ command: process.execPath, argv: ["resume", session_id, resume_input], cwd: root, env: {}, input: null }),
    parse: (output) => ({ text: output.trim(), session_id: `${id}-session`, error_code: null }),
  }; } };
  const broker = new LiveBroker({ supervisor, adapters, recovery: { record() {} } });
  const firstRequest = { protocol_version: 3, request_id: "66666666-6666-4666-8666-666666666666", nonce: null, round: 1, runtime_id: null, previous_receipt_hash: null, host_hint: { provider: "host", backend: "test", wrapper_hash: "test" }, material: createMaterial("first material"), contract_ref: "opaque://test/contract", force_tier: 0, overrides: {} };
  const initial = await broker.run({ request: firstRequest, config, options: { cwd: root } });
  const previous_receipts = Object.fromEntries(initial.providers.map((provider) => [provider.id, broker.readPrivate({ runtime_id: initial.runtime_id, provider: provider.id, nonce: initial.nonce, ref: "receipt", round: 1 }).receipt_hash]));
  const secondRequest = { protocol_version: 3, request_id: createRequestId(), nonce: initial.nonce, round: 2, runtime_id: initial.runtime_id, previous_receipt_hash: null, previous_receipts, host_hint: firstRequest.host_hint, material: createMaterial("revised delta"), contract_ref: firstRequest.contract_ref, force_tier: null, overrides: {} };
  const continued = await broker.run({ request: secondRequest, config, options: { cwd: root } });
  assert.equal(continued.providers.length, 2);
  assert.deepEqual(calls.map(([provider, operation]) => [provider, operation]), [["alpha", "start"], ["beta", "start"], ["alpha", "resume"], ["beta", "resume"]]);
  assert.equal(broker.readPrivate({ runtime_id: initial.runtime_id, provider: "alpha", nonce: initial.nonce, ref: "result", round: 1 }), "round1-alpha");
  assert.equal(broker.readPrivate({ runtime_id: initial.runtime_id, provider: "alpha", nonce: initial.nonce, ref: "result", round: 2 }), "round2-alpha");
  const receipt = broker.readPrivate({ runtime_id: initial.runtime_id, provider: "alpha", nonce: initial.nonce, ref: "receipt", round: 2 });
  assert.equal(receipt.parent_receipt_hash, previous_receipts.alpha);
  assert.equal(receipt.material_hash, secondRequest.material.input_hash);
});
