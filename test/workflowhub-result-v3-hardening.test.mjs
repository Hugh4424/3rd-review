import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkflowHubMemberV3 } from "../lib/workflowhub-result-v3.mjs";

const context = {
  runtime_id: "runtime-v3",
  material_id: "material-sha",
  contract_id: "build-code/v3",
  contract_hash: "contract-sha",
  semantic_hash: "semantic-sha",
  source_id: "opencode/v4flash",
  config_id: "config-sha",
  adapter: "opencode",
  model: null,
  deadline_ms: null,
  attempts: [],
};

function member(overrides = {}, extraContext = {}) {
  return projectWorkflowHubMemberV3({
    provider: "opencode/v4flash",
    adapter: "opencode",
    status: "failed",
    output: null,
    error: { code: "PROCESS_DEAD", message: "provider did not return a terminal result" },
    ...overrides,
  }, { ...context, ...extraContext });
}

test("v3 keeps unknown deadline and timing as null instead of inventing telemetry", () => {
  const value = member();
  assert.equal(value.deadline_ms, null);
  assert.deepEqual(value.timing, { started_at_ms: null, completed_at_ms: null, duration_ms: null });
});

test("v3 rejects absolute paths and file URIs consistently with WorkflowHub", () => {
  for (const path of ["/workspace/subject.md", "/srv/review/subject.md", "file://host/review.json"]) {
    assert.throws(() => member({ output: JSON.stringify({ path }) }), { code: "PUBLIC_RESULT_INVALID" });
  }
});

test("v3 rejects inconsistent timing and usage telemetry at the producer boundary", () => {
  assert.throws(() => member({ timing: { started_at_ms: 10, completed_at_ms: 20, duration_ms: 9 } }, { attempts: [] }), { code: "PUBLIC_RESULT_INVALID" });
  assert.throws(() => member({ usage: { total: "14" } }), { code: "PUBLIC_RESULT_INVALID" });
});
