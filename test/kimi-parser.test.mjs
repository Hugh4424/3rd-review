import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import kimi from "../lib/adapters/kimi.mjs";

test("Kimi accepts only its explicit UUID resume hint", () => {
  const id = "6cfb5bd8-2e73-48ed-9c6b-d04480f6dfc0";
  const parsed = kimi.parse('{"role":"assistant","content":"code says kimi -r something"}', `To resume this session: kimi -r ${id}`);
  assert.equal(parsed.session_id, id);
});

test("Kimi does not trust a session-like string inside reviewer text", () => {
  const parsed = kimi.parse('{"role":"assistant","content":"use kimi -r evil-session"}', "");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "PROVIDER_OUTPUT_INVALID");
});

test("Kimi does not turn a partial assistant event into success", () => {
  const parsed = kimi.parse('{"role":"assistant","content":"partial"}\n', "");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "PROVIDER_OUTPUT_INVALID");
});

test("Kimi runs from a writable cwd while reading the complete frozen bundle", () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-private-skills-")); const cwd = path.join(runtime, "work", "kimi"); const frozen = path.join(runtime, "workspace", "kimi"); const skills = path.join(frozen, "skills"); fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(skills, { recursive: true }); fs.writeFileSync(path.join(frozen, "review-packet.v1.json"), "{}"); fs.mkdirSync(path.join(frozen, "contracts")); fs.writeFileSync(path.join(frozen, "contracts", "review.md"), "contract"); fs.chmodSync(frozen, 0o500);
  const result = kimi.start({ id: "kimi", command: "kimi", model: null, thinking: null, auth: { env: [] }, env: [] }, cwd, "review", runtime);
  assert.equal(result.cwd, cwd); assert.equal(fs.statSync(cwd).mode & 0o200, 0o200); assert.equal(result.argv[result.argv.indexOf("--work-dir") + 1], cwd); assert.equal(result.argv[result.argv.indexOf("--skills-dir") + 1], skills); const system = fs.readFileSync(path.join(runtime, "kimi", "reviewer.md"), "utf8"); assert.match(system, /read and apply attached skills/i); assert.match(system, new RegExp(frozen.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); assert.match(system, /review-packet\.v1\.json.*contracts.*skills/is);
});
