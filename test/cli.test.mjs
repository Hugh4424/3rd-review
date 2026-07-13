import assert from "node:assert/strict";
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
