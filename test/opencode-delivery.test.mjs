import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import opencode from "../lib/adapters/opencode.mjs";

test("OpenCode receives the complete 80KB provider prompt on stdin", () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-stdin-")); const cwd = path.join(runtime, "embed", "opencode"); fs.mkdirSync(cwd, { recursive: true }); const prompt = `ATTACHMENT_HEAD\n${"x".repeat(80 * 1024)}\nATTACHMENT_TAIL`;
  const result = opencode.start({ id: "opencode", command: "opencode", model: null, effort: null, auth: { env: [] }, env: [] }, cwd, prompt, runtime);
  assert.equal(result.input, prompt); assert.ok(Buffer.byteLength(result.input) > 80_000); assert.match(result.input, /^ATTACHMENT_HEAD/); assert.match(result.input, /ATTACHMENT_TAIL$/); assert.equal(result.argv.includes("--file"), false); assert.equal(result.argv.includes("--agent"), false); assert.doesNotMatch(result.argv.join(" "), /review-input|Read tool|offset|EOF/i); assert.equal(result.argv.join(" ").includes(process.cwd()), false); assert.equal(result.env.OPENCODE_CONFIG, undefined); assert.equal(fs.existsSync(path.join(cwd, ".broker-profile")), false); assert.equal(fs.existsSync(path.join(cwd, "review-input.md")), false);
});
