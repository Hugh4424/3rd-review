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
