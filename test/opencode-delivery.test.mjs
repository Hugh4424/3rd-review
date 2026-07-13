import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import opencode from "../lib/adapters/opencode.mjs";

test("OpenCode reads the isolated prompt file through EOF without --file summarization", () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-eof-")); const cwd = path.join(runtime, "embed", "opencode"); fs.mkdirSync(cwd, { recursive: true }); const prompt = `ATTACHMENT_HEAD\n${"x".repeat(3000)}\nATTACHMENT_TAIL`;
  const result = opencode.start({ id: "opencode", command: "opencode", model: null, effort: null, auth: { env: [] }, env: [] }, cwd, prompt, runtime);
  assert.equal(result.argv.includes("--file"), false); assert.match(result.argv.at(-1), /review-input\.md/i); assert.match(result.argv.at(-1), /chunk|offset/i); assert.match(result.argv.at(-1), /EOF|end of file/i);
  const delivered = fs.readFileSync(path.join(cwd, "review-input.md"), "utf8"); assert.ok(delivered.length > 2000); assert.match(delivered, /^ATTACHMENT_HEAD/); assert.match(delivered, /ATTACHMENT_TAIL$/);
});
