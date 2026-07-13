import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("CLI rejects the obsolete host-provider argument", () => {
  const cli = path.resolve("scripts/3rd-review.mjs");
  const result = spawnSync(process.execPath, [cli, "run", "--host-provider=codex"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported argument for run/);
});

test("CLI accepts attachment flags on run and source on cancel", () => {
  const cli = path.resolve("scripts/3rd-review.mjs");
  const run = spawnSync(process.execPath, [cli, "run", "--attachments=manifest.json", "--attachments-root=/tmp", "--attachment-delivery=file_only"], { encoding: "utf8" });
  assert.equal(run.status, 2); assert.doesNotMatch(run.stderr, /unsupported argument for run/); assert.match(run.stderr, /--request is required/);
  const cancel = spawnSync(process.execPath, [cli, "cancel", "--source=workflowhub"], { encoding: "utf8" });
  assert.equal(cancel.status, 2); assert.doesNotMatch(cancel.stderr, /unsupported argument for cancel/);
});

test("CLI requires all three attachment flags together", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-cli-attachments-")); const cli = path.resolve("scripts/3rd-review.mjs"); const config = path.join(root, "config.json"); const request = path.join(root, "request.json");
  fs.writeFileSync(config, JSON.stringify({ version: 4, runtime: { root: path.join(root, "runtime"), max_duration_ms: 1000 }, tiers: [["kimi"]], providers: { kimi: { command: path.resolve("test/fake-cli.mjs"), auth: { type: "native" } } } })); fs.writeFileSync(request, JSON.stringify({ version: 4, host_provider: "codex", prompt: "review", continuation: null }));
  const result = spawnSync(process.execPath, [cli, "run", `--config=${config}`, `--request=${request}`, "--attachments=manifest.json"], { encoding: "utf8" });
  assert.equal(result.status, 2); assert.match(result.stderr, /required together/);
});
