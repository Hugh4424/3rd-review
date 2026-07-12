import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ProtocolError,
  canonicalConfigHash,
  createMaterial,
  createNonce,
  sha256,
  validateRequest,
} from "../../lib/v3/protocol.mjs";
import { MockBroker, createMockAdapter } from "../../lib/v3/mock-broker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.resolve(here, "../../scripts/3rd-review.mjs");

function request(overrides = {}) {
  const material = createMaterial("review this bounded payload");
  return {
    protocol_version: 3,
    request_id: randomUUID(),
    nonce: null,
    runtime_id: null,
    round: 1,
    host_hint: { provider: "codex", backend: "codex-cli", wrapper_hash: "sha256:test" },
    material,
    contract_ref: "opaque://wh-review/contract-test",
    previous_receipt_hash: null,
    force_tier: null,
    overrides: {},
    ...overrides,
  };
}

test("material delivery rejects invalid Unicode and mismatched byte/hash declarations before dispatch", () => {
  const good = createMaterial("中文 ok");
  assert.equal(validateRequest(request({ material: good })).material.input_hash, good.input_hash);

  assert.throws(
    () => validateRequest(request({ material: { ...good, bytes: good.bytes + 1 } })),
    (error) => error instanceof ProtocolError && error.code === "REQUEST_INVALID",
  );
  assert.throws(
    () => createMaterial("bad\ud800"),
    (error) => error instanceof ProtocolError && error.code === "REQUEST_INVALID",
  );
});

test("config hash is canonical and rejects non-interoperable numbers", () => {
  const one = canonicalConfigHash({ z: [null, 3], a: { b: true, a: "x" } });
  const two = canonicalConfigHash({ a: { a: "x", b: true }, z: [null, 3] });
  assert.equal(one.hash, two.hash);
  assert.equal(one.canonical_json, two.canonical_json);
  assert.throws(
    () => canonicalConfigHash({ bad: -0 }),
    (error) => error instanceof ProtocolError && error.code === "CONFIG_INVALID",
  );
});

test("mock broker freezes generic execution protocol without interpreting a business verdict", async () => {
  let calls = 0;
  const adapter = createMockAdapter({
    id: "kimi",
    profile: { model: "kimi-code", backend: "native", auth_mode: "native_login" },
    execute: async (ctx) => {
      calls += 1;
      assert.equal(ctx.material.text, "review this bounded payload");
      assert.equal(ctx.material.input_hash, ctx.request.material.input_hash);
      return {
        raw: '{"status":"anything"}',
        session_id: "kimi-session-1",
        execution_eligible: true,
        metrics: { elapsed_ms: 7, turns: 1, input_bytes: ctx.material.bytes, output_bytes: 21, retry_count: 0 },
      };
    },
  });
  const broker = new MockBroker({ now: () => 1_000 });
  const submitted = request();
  const first = await broker.run(submitted, { config: { version: 3, defaults: { deadline_seconds: null } }, adapter });

  assert.equal(first.providers[0].id, "kimi");
  assert.equal(first.providers[0].session_id, "kimi-session-1");
  assert.equal(first.providers[0].execution_eligible, true);
  assert.equal(first.providers[0].runtime_id.length > 0, true);
  assert.equal("verdict" in first, false);
  assert.equal("findings" in first.providers[0], false);
  assert.equal(first.nonce.length > 0, true);
  assert.equal(calls, 1);

  const receipt = broker.readPrivate({
    runtime_id: first.providers[0].runtime_id,
    provider: "kimi",
    nonce: first.nonce,
    ref: "receipt",
  });
  assert.equal(receipt.config_hash, first.config_hash);
  assert.equal(receipt.material_hash, submitted.material.input_hash);
  assert.equal(receipt.session_id, "kimi-session-1");
  assert.match(receipt.provider_profile_hash, /^sha256:[a-f0-9]{64}$/);
});

test("same request+nonce is idempotent; missing/different nonce cannot create another job", async () => {
  let calls = 0;
  const adapter = createMockAdapter({ id: "claude-code", execute: async () => ({ raw: "ok", execution_eligible: true, session_id: "s1", metrics: {}, onCall: ++calls }) });
  const broker = new MockBroker({ now: () => 1_000 });
  const initial = request();
  const first = await broker.run(initial, { config: { version: 3 }, adapter });
  const replay = await broker.run({ ...initial, nonce: first.nonce }, { config: { version: 3 }, adapter });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);

  await assert.rejects(
    broker.run({ ...initial, nonce: null }, { config: { version: 3 }, adapter }),
    (error) => error instanceof ProtocolError && error.code === "NONCE_REQUIRED",
  );
  await assert.rejects(
    broker.run({ ...initial, nonce: createNonce() }, { config: { version: 3 }, adapter }),
    (error) => error instanceof ProtocolError && error.code === "REPLAY_DETECTED",
  );
});

test("read-private is bound to runtime, provider, nonce and a closed ref set", async () => {
  const broker = new MockBroker({ now: () => 1_000 });
  const result = await broker.run(request(), { config: { version: 3 }, adapter: createMockAdapter({ id: "opencode", execute: async () => ({ raw: "sensitive", execution_eligible: true, metrics: {} }) }) });
  const selector = { runtime_id: result.providers[0].runtime_id, provider: "opencode", nonce: result.nonce };
  assert.equal(broker.readPrivate({ ...selector, ref: "raw" }), "sensitive");
  assert.throws(
    () => broker.readPrivate({ ...selector, nonce: createNonce(), ref: "raw" }),
    (error) => error instanceof ProtocolError && error.code === "BINDING_MISMATCH",
  );
  assert.throws(
    () => broker.readPrivate({ ...selector, ref: "../../raw" }),
    (error) => error instanceof ProtocolError && error.code === "REQUEST_INVALID",
  );
});

test("request shape is validated before replay lookup, private receipts expire, and hash inputs are typed", async () => {
  let now = 1_000;
  const broker = new MockBroker({ now: () => now });
  const adapter = createMockAdapter({ id: "codex", execute: async () => ({ raw: "ok", execution_eligible: true, metrics: {} }) });
  const result = await broker.run(request(), { config: { version: 3 }, adapter });
  await assert.rejects(
    broker.run({ ...request({ request_id: "not-a-uuid" }), nonce: result.nonce }, { config: { version: 3 }, adapter }),
    (error) => error instanceof ProtocolError && error.code === "REQUEST_INVALID",
  );
  now += (24 * 60 * 60 * 1_000) + 1;
  assert.throws(
    () => broker.readPrivate({ runtime_id: result.providers[0].runtime_id, provider: "codex", nonce: result.nonce, ref: "receipt" }),
    (error) => error instanceof ProtocolError && error.code === "NONCE_EXPIRED",
  );
  assert.throws(() => sha256({}), TypeError);
});

test("new entrypoint validates a request and writes a protocol-only result through the mock baseline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-v3-test-"));
  try {
    const input = path.join(root, "request.json");
    const output = path.join(root, "result.json");
    writeFileSync(input, JSON.stringify(request({ nonce: createNonce() })), "utf8");
    const run = spawnSync(process.execPath, [entrypoint, "run", `--request=${input}`, `--output=${output}`, "--adapter=mock"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(result.protocol_version, 3);
    assert.equal(result.providers[0].id, "mock");
    assert.equal("verdict" in result, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
