import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { detectHost } from "./detect-host.mjs";

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("claude detection writes session-state.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "detect-host-"));
  const sessionStatePath = join(dir, "session-state.json");

  try {
    const host = await withEnv(
      { REVIEW_TEST_MODE: "1", HOST_ENGINE_OVERRIDE: "claude", NODE_ENV: undefined },
      () => detectHost(sessionStatePath),
    );

    assert.equal(host, "claude");
    const state = JSON.parse(await readFile(sessionStatePath, "utf8"));
    assert.equal(state.host_engine, "claude");
    assert.match(state.detected_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing session-state.json is returned without re-detection outside test mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "detect-host-"));
  const sessionStatePath = join(dir, "session-state.json");

  try {
    await writeFile(
      sessionStatePath,
      JSON.stringify({ host_engine: "codex", detected_at: new Date().toISOString() }),
    );

    const host = await withEnv(
      { REVIEW_TEST_MODE: undefined, HOST_ENGINE_OVERRIDE: "claude", NODE_ENV: undefined },
      () => detectHost(sessionStatePath),
    );

    assert.equal(host, "codex");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("test override refreshes stale session-state.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "detect-host-"));
  const sessionStatePath = join(dir, "session-state.json");

  try {
    await writeFile(
      sessionStatePath,
      JSON.stringify({ host_engine: "codex", detected_at: new Date().toISOString() }),
    );

    const host = await withEnv(
      { REVIEW_TEST_MODE: "1", HOST_ENGINE_OVERRIDE: "claude", NODE_ENV: undefined },
      () => detectHost(sessionStatePath),
    );

    assert.equal(host, "claude");
    const state = JSON.parse(await readFile(sessionStatePath, "utf8"));
    assert.equal(state.host_engine, "claude");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid cached session-state.json host is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "detect-host-"));
  const sessionStatePath = join(dir, "session-state.json");

  try {
    await writeFile(sessionStatePath, JSON.stringify({ host_engine: "openai", detected_at: new Date().toISOString() }));

    await assert.rejects(
      withEnv(
        { REVIEW_TEST_MODE: "1", HOST_ENGINE_OVERRIDE: "claude", NODE_ENV: undefined },
        () => detectHost(sessionStatePath),
      ),
      /Invalid cached host_engine/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown host throws and does not write session-state.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "detect-host-"));
  const sessionStatePath = join(dir, "session-state.json");

  try {
    await assert.rejects(
      withEnv(
        { REVIEW_TEST_MODE: "1", HOST_ENGINE_OVERRIDE: "unknown", NODE_ENV: undefined },
        () => detectHost(sessionStatePath),
      ),
      /Unable to detect host engine/,
    );
    assert.equal(await exists(sessionStatePath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("process-name fallback detects normalized engines outside test mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "detect-host-"));
  const sessionStatePath = join(dir, "session-state.json");

  try {
    const host = await withEnv(
      { REVIEW_TEST_MODE: undefined, HOST_ENGINE_OVERRIDE: undefined, NODE_ENV: undefined, _: "/usr/local/bin/codex" },
      () => detectHost(sessionStatePath),
    );
    assert.equal(host, "codex");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("process-name fallback does not match engine names as substrings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "detect-host-"));
  const sessionStatePath = join(dir, "session-state.json");

  try {
    await assert.rejects(
      withEnv(
        { REVIEW_TEST_MODE: undefined, HOST_ENGINE_OVERRIDE: undefined, NODE_ENV: undefined, _: "/tmp/notcodex" },
        () => detectHost(sessionStatePath),
      ),
      /Unable to detect host engine/,
    );
    assert.equal(await exists(sessionStatePath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
