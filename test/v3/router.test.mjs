import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, validateConfig } from "../../lib/v3/config.mjs";
import { routeProviders } from "../../lib/v3/router.mjs";

function config(overrides = {}) {
  return {
    version: 3,
    tiers: [["claude-code", "kimi"], ["opencode"]],
    defaults: { deadline_seconds: null, max_input_bytes: 524288, max_output_bytes: 1048576, poll_interval_ms: 5000 },
    providers: {
      "claude-code": { enabled: true, command: "/usr/local/bin/claude", model: "haiku", effort: "low", thinking: null, auth_mode: "native_login", auth_env: [] },
      kimi: { enabled: true, command: "/usr/local/bin/kimi", model: "kimi", effort: "low", thinking: null, auth_mode: "native_login", auth_env: [] },
      opencode: { enabled: true, command: "/usr/local/bin/opencode", model: "provider/model", effort: "low", thinking: null, auth_mode: "config_ref", auth_env: [] },
    },
    ...overrides,
  };
}

test("global config is strict, hashable, and stores only auth environment names", () => {
  const validated = validateConfig(config());
  assert.match(validated.config_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(validated.config.tiers[0], ["claude-code", "kimi"]);
  assert.equal(validated.config.providers.kimi.thinking, null);
  assert.equal(validateConfig(config({ providers: { ...config().providers, kimi: { ...config().providers.kimi, thinking: false } } })).config.providers.kimi.thinking, false);
  assert.throws(() => validateConfig(config({ providers: { ...config().providers, kimi: { ...config().providers.kimi, thinking: "low" } } })), { code: "CONFIG_INVALID" });
  assert.throws(() => validateConfig(config({ providers: { ...config().providers, kimi: { ...config().providers.kimi, api_key: "secret" } } })), { code: "CONFIG_INVALID" });
  assert.throws(() => validateConfig(config({ tiers: [["kimi", "kimi"]] })), { code: "CONFIG_INVALID" });
  assert.throws(() => validateConfig(config({ defaults: { api_key: "secret" } })), { code: "CONFIG_INVALID" });
});

test("config loader requires private JSON permissions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-config-"));
  const file = path.join(root, "config.json");
  try {
    writeFileSync(file, JSON.stringify(config()), { mode: 0o600 });
    assert.equal(loadConfig(file).config.version, 3);
    chmodSync(file, 0o644);
    assert.throws(() => loadConfig(file), { code: "CONFIG_INVALID" });
    chmodSync(file, 0o600);
    const link = path.join(root, "config-link.json");
    symlinkSync(file, link);
    assert.throws(() => loadConfig(link), { code: "CONFIG_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("router excludes same-source, keeps failures, and stops only when a tier has eligible success", async () => {
  const calls = [];
  const result = await routeProviders({
    config: validateConfig(config()), host_provider: "claude-code",
    execute: async (provider) => {
      calls.push(provider.id);
      if (provider.id === "kimi") return { execution_eligible: false, error_code: "AUTH_UNAVAILABLE" };
      return { execution_eligible: true, session_id: "open-session" };
    },
  });
  assert.deepEqual(calls, ["kimi", "opencode"]);
  assert.equal(result.selected_tier, 1);
  assert.equal(result.stop_reason, "execution_eligible");
  assert.deepEqual(result.providers.map((entry) => [entry.id, entry.status, entry.error_code]), [
    ["claude-code", "skipped", "SAME_SOURCE"],
    ["kimi", "failed", "AUTH_UNAVAILABLE"],
    ["opencode", "completed", null],
  ]);
});

test("router preserves partial tier successes and rejects invalid force_tier", async () => {
  const result = await routeProviders({
    config: validateConfig(config()), host_provider: "unknown-host",
    execute: async (provider) => provider.id === "kimi"
      ? { execution_eligible: true, session_id: "kimi-session" }
      : { execution_eligible: false, error_code: "NETWORK_UNAVAILABLE" },
  });
  assert.equal(result.selected_tier, 0);
  assert.equal(result.providers.length, 2);
  assert.equal(result.providers.some((entry) => entry.id === "opencode"), false);
  await assert.rejects(
    routeProviders({ config: validateConfig(config()), force_tier: 9, execute: async () => ({ execution_eligible: false }) }),
    { code: "REQUEST_INVALID" },
  );
});

test("unverified host results are retained as reference but cannot stop fallback", async () => {
  const calls = [];
  const result = await routeProviders({
    config: validateConfig(config()), host_provider: "unknown", host_verified: false,
    execute: async (provider) => { calls.push(provider.id); return { execution_eligible: true, session_id: `${provider.id}-session` }; },
  });
  assert.deepEqual(calls, ["claude-code", "kimi", "opencode"]);
  assert.equal(result.stop_reason, "no_eligible");
  assert.equal(result.providers.every((entry) => entry.execution_eligible === false && entry.error_code === "HOST_UNKNOWN"), true);
  assert.equal(result.providers.every((entry) => entry.session_id === null), true);
});

test("valid force_tier runs only that tier and failures retain their transport diagnostics", async () => {
  const calls = [];
  const result = await routeProviders({
    config: validateConfig(config()), force_tier: 1,
    execute: async (provider) => { calls.push(provider.id); throw new Error("network dropped"); },
  });
  assert.deepEqual(calls, ["opencode"]);
  assert.equal(result.selected_tier, 1);
  assert.equal(result.stop_reason, "all_failed");
  assert.deepEqual(result.providers.map((entry) => [entry.id, entry.error_code]), [["opencode", "ADAPTER_FAILED"]]);
});

test("unverified host does not exclude same source and disabled-only tiers fall through", async () => {
  const disabled = config({ providers: { ...config().providers, kimi: { ...config().providers.kimi, enabled: false } } });
  const calls = [];
  const result = await routeProviders({
    config: validateConfig(disabled), host_provider: "claude-code", host_verified: false,
    execute: async (provider) => { calls.push(provider.id); return { execution_eligible: true }; },
  });
  assert.deepEqual(calls, ["claude-code", "opencode"]);
  assert.equal(result.stop_reason, "no_eligible");
  assert.equal(result.providers.find((entry) => entry.id === "kimi").error_code, "PROVIDER_DISABLED");
});
