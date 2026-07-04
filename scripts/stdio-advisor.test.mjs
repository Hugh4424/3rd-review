import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { checkEngineAvailability, queryAvailableEngine } from "./stdio-advisor.mjs";

const OFFLINE_ENGINES = [
  { id: "claude", provider: "anthropic", model: "claude", available: true },
  { id: "codex", provider: "openai", model: "codex", available: true },
  { id: "kimi", provider: "moonshot", model: "kimi", available: true },
  { id: "cursor", provider: "cursor", model: "cursor", available: true },
  { id: "opencode", provider: "opencode", model: "opencode", available: true },
  { id: "antigravity", provider: "antigravity", model: "antigravity", available: true },
];

async function withOfflineEngines(fn) {
  const dir = await mkdtemp(join(tmpdir(), "stdio-advisor-"));
  const filePath = join(dir, "offline-engines.json");
  await writeFile(filePath, JSON.stringify(OFFLINE_ENGINES, null, 2));
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function spawnResult({ stdout = "", stderr = "", exitCode = 0, error = null, neverClose = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
      child.emit("close", null, "SIGTERM");
    };

    queueMicrotask(() => {
      if (error) {
        child.emit("error", error);
        return;
      }
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      if (!neverClose) child.emit("close", exitCode, null);
    });

    return child;
  };
}

test("queryAvailableEngine returns first available heterologous engine", async () => {
  await withOfflineEngines(async (offlineEnginesPath) => {
    const checked = [];
    const result = await queryAvailableEngine({
      hostEngine: "claude",
      round: 1,
      offlineEnginesPath,
      checkFn: async ({ candidateEngine }) => {
        checked.push(candidateEngine.id);
        return { provider: candidateEngine.provider, model: candidateEngine.model, available: true };
      },
    });

    assert.deepEqual(result, { engine: "codex" });
    assert.deepEqual(checked, ["codex"]);
  });
});

test("queryAvailableEngine skips same-source and returns the next available engine", async () => {
  await withOfflineEngines(async (offlineEnginesPath) => {
    const checked = [];
    const result = await queryAvailableEngine({
      hostEngine: "codex",
      round: 1,
      offlineEnginesPath,
      checkFn: async ({ candidateEngine }) => {
        checked.push(candidateEngine.id);
        return { provider: candidateEngine.provider, model: candidateEngine.model, available: true };
      },
    });

    assert.deepEqual(result, { engine: "claude" });
    assert.deepEqual(checked, ["claude"]);
  });
});

test("checkEngineAvailability reports a 10s timeout", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({ neverClose: true }),
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.model, "codex");
  assert.equal(result.available, false);
  assert.equal(result.skip_reason, "timeout");
  assert.match(result.error, /10000ms/);
});

test("checkEngineAvailability skips same-provider candidates", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "claude-alt", provider: "anthropic", model: "claude-alt" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({ stdout: JSON.stringify({ provider: "anthropic", model: "claude-alt", available: true }) }),
  });

  assert.equal(result.available, false);
  assert.equal(result.skip_reason, "same_source_provider");
});

test("checkEngineAvailability reports spawn ENOENT", async () => {
  const error = Object.assign(new Error("spawn omc ENOENT"), { code: "ENOENT" });
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({ error }),
  });

  assert.equal(result.available, false);
  assert.equal(result.skip_reason, "spawn_enoent");
  assert.match(result.error, /ENOENT/);
});

test("checkEngineAvailability reports MODULE_NOT_FOUND", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({ stderr: "Error: MODULE_NOT_FOUND\n", exitCode: 1 }),
  });

  assert.equal(result.available, false);
  assert.equal(result.skip_reason, "module_not_found");
  assert.match(result.error, /MODULE_NOT_FOUND/);
});

test("checkEngineAvailability reports action_not_supported", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({ stdout: JSON.stringify({ error: "action_not_supported" }), exitCode: 0 }),
  });

  assert.equal(result.available, false);
  assert.equal(result.skip_reason, "action_not_supported");
  assert.match(result.error, /action_not_supported/);
});

test("checkEngineAvailability rejects malformed successful stdout", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({ stdout: "not json", exitCode: 0 }),
  });

  assert.equal(result.available, false);
  assert.equal(result.skip_reason, "invalid_response");
  assert.match(result.error, /valid JSON/);
});

test("checkEngineAvailability parses JSON after CLI log output", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({
      stdout: "warning: using cached provider\n" + JSON.stringify({ provider: "openai", model: "codex", available: true }),
      exitCode: 0,
    }),
  });

  assert.equal(result.available, true);
  assert.equal(result.provider, "openai");
});

test("checkEngineAvailability ignores harmless stderr tokens when stdout is available", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({
      stdout: JSON.stringify({ provider: "openai", model: "codex", available: true }),
      stderr: "debug: optional MODULE_NOT_FOUND from plugin probe\n",
      exitCode: 0,
    }),
  });

  assert.equal(result.available, true);
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "codex");
  assert.equal(result.skip_reason, undefined);
});

test("checkEngineAvailability parses nested JSON after CLI log output", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({
      stdout:
        "warning: using cached provider\n" +
        JSON.stringify({
          provider: "openai",
          model: "codex",
          available: true,
          meta: { provider: "openai", source: "stdio" },
        }),
      exitCode: 0,
    }),
  });

  assert.equal(result.available, true);
  assert.equal(result.provider, "openai");
});

test("checkEngineAvailability requires available=true in successful JSON", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({ stdout: JSON.stringify({ provider: "openai", model: "codex" }), exitCode: 0 }),
  });

  assert.equal(result.available, false);
  assert.equal(result.skip_reason, "unavailable");
});

test("checkEngineAvailability reports nonzero exit before invalid stdout", async () => {
  const result = await checkEngineAvailability({
    candidateEngine: { id: "codex", provider: "openai", model: "codex" },
    hostEngine: "claude",
    round: 1,
    omcPath: "/fake/omc",
    spawnFn: spawnResult({ stdout: "not json", stderr: "failed", exitCode: 1 }),
  });

  assert.equal(result.available, false);
  assert.equal(result.skip_reason, "nonzero_exit");
  assert.match(result.error, /failed/);
});

test("queryAvailableEngine escalates when all offline engines are unreachable", async () => {
  await withOfflineEngines(async (offlineEnginesPath) => {
    const result = await queryAvailableEngine({
      hostEngine: "claude",
      round: 1,
      offlineEnginesPath,
      checkFn: async ({ candidateEngine }) => ({
        provider: candidateEngine.provider,
        model: candidateEngine.model,
        available: false,
        skip_reason: "spawn_enoent",
      }),
    });

    assert.deepEqual(result, { escalate: true });
  });
});
