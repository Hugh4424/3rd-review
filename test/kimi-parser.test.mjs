import assert from "node:assert/strict";
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
