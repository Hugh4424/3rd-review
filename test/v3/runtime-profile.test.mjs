import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareRuntimeProfile } from "../../lib/v3/runtime-profile.mjs";

test("Kimi and OpenCode receive broker-owned private read-only profiles", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const material = { text: "bounded review package" };
  const kimi = prepareRuntimeProfile({ runtimeRoot: root, runtimeId: "runtime_kimi", providerId: "kimi", material });
  const openCode = prepareRuntimeProfile({ runtimeRoot: root, runtimeId: "runtime_open", providerId: "opencode", material });
  assert.match(readFileSync(kimi.profile_path, "utf8"), /ReadFile/);
  assert.match(readFileSync(kimi.profile_path, "utf8"), /Grep/);
  assert.equal(lstatSync(kimi.profile_path).mode & 0o077, 0);
  assert.equal(readFileSync(path.join(kimi.cwd, "review-package.md"), "utf8"), material.text);
  assert.equal(openCode.profile_name, "third-review-readonly");
  assert.equal(openCode.runtime_env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  const config = readFileSync(openCode.runtime_env.OPENCODE_CONFIG, "utf8");
  assert.match(config, /"\*":"deny"/);
  assert.match(config, /"bash":"deny"/);
  assert.match(config, /"read":"allow"/);
  assert.equal(lstatSync(openCode.runtime_env.OPENCODE_CONFIG).mode & 0o077, 0);
});

test("runtime profile refuses a pre-existing symlink instead of following it", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-profile-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime_kimi", "materials");
  mkdirSync(path.dirname(runtime), { recursive: true, mode: 0o700 });
  // The runtime root is private, but this regression test protects against a stale hostile entry.
  symlinkSync("/tmp", runtime, "dir");
  assert.throws(() => prepareRuntimeProfile({ runtimeRoot: root, runtimeId: "runtime_kimi", providerId: "kimi", material: { text: "x" } }), { code: "RUNTIME_UNAVAILABLE" });
});
