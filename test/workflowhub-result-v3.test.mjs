import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOWHUB_RESULT_PROTOCOL_V3,
  assertWorkflowHubResultV3,
  createWorkflowHubResultV3,
  projectWorkflowHubMemberV3,
} from "../lib/workflowhub-result-v3.mjs";

const context = {
  runtime_id: "runtime-v3",
  round: 1,
  host_provider: "codex",
  selected_tier: null,
  material_id: "material-sha",
  contract_id: "build-code/v3",
  contract_hash: "contract-sha",
  semantic_hash: "semantic-sha",
  config_id: "config-sha",
  source_id: "pi/k3",
  deadline_ms: 250,
  attempts: [
    {
      attempt_id: "attempt-1",
      kind: "initial",
      status: "failed",
      started_at_ms: 100,
      completed_at_ms: 110,
      duration_ms: 10,
      session_id: "session-1",
      error: { code: "PROCESS_TIMEOUT", message: "provider process exceeded its review deadline" },
      provider_retry_count: 2,
    },
    {
      attempt_id: "attempt-2",
      kind: "same_session_repair",
      status: "completed",
      started_at_ms: 111,
      completed_at_ms: 121,
      duration_ms: 10,
      session_id: "session-1",
      error: null,
      provider_retry_count: 0,
    },
  ],
};

test("v3 keeps member identity, attempts, recovery counters, usage, timing, and safe provenance", () => {
  const member = projectWorkflowHubMemberV3({
    provider: "pi/k3",
    adapter: "pi",
    model: "kimi-coding/k3",
    effort: null,
    thinking: true,
    status: "completed",
    session_id: "session-1",
    continuable: true,
    usage: null,
    timing: { started_at_ms: 100, completed_at_ms: 121, duration_ms: 21 },
    retry: { count: 2, progress_events: 3 },
    output: "{\"findings\":[]}",
    error: null,
  }, context);

  assert.equal(member.result_protocol, WORKFLOWHUB_RESULT_PROTOCOL_V3);
  assert.deepEqual(member.identity, {
    provider: "pi/k3",
    adapter: "pi",
    model: "kimi-coding/k3",
    source_id: "pi/k3",
    config_id: "config-sha",
  });
  assert.deepEqual(member.material, {
    material_id: "material-sha",
    contract_id: "build-code/v3",
    contract_hash: "contract-sha",
    semantic_hash: "semantic-sha",
  });
  assert.equal(member.deadline_ms, 250);
  assert.equal(member.usage, null);
  assert.equal(member.recovery.provider_internal_retry_count, 2);
  assert.equal(member.recovery.fresh_execution_retry_count, 0);
  assert.equal(member.recovery.same_session_repair_count, 1);
  assert.equal(member.attempts.length, 2);
  assert.equal(member.provenance.raw_output_sha256, null);
  assert.equal(Object.hasOwn(member.provenance, "raw_output_ref"), false);
});

test("v3 aggregate preserves partial member success and cannot accept a v2 group", () => {
  const completed = projectWorkflowHubMemberV3({
    provider: "pi/k3", adapter: "pi", model: "kimi-coding/k3", status: "completed",
    session_id: "session-1", continuable: true, usage: { totalTokens: 9 },
    timing: { started_at_ms: 100, completed_at_ms: 120, duration_ms: 20 },
    retry: { count: 2, progress_events: 1 }, output: "ok", error: null,
  }, context);
  const failed = projectWorkflowHubMemberV3({
    provider: "opencode/v4flash", adapter: "opencode", model: "opencode/deepseek-v4-flash", status: "failed",
    session_id: null, continuable: false, usage: null,
    timing: { started_at_ms: 100, completed_at_ms: 140, duration_ms: 40 },
    retry: { count: 0, progress_events: 0 }, output: null,
    error: { code: "PROCESS_TIMEOUT", message: "provider process exceeded its review deadline" },
  }, { ...context, source_id: "opencode/v4flash", deadline_ms: 300, attempts: [] });
  const group = createWorkflowHubResultV3({ ...context, providers: [completed, failed] });

  assert.equal(group.version, WORKFLOWHUB_RESULT_PROTOCOL_V3);
  assert.equal(group.outcome, "partial");
  assert.deepEqual(group.providers.map(({ identity, status }) => ({ provider: identity.provider, status })), [
    { provider: "pi/k3", status: "completed" },
    { provider: "opencode/v4flash", status: "failed" },
  ]);
  assert.doesNotThrow(() => assertWorkflowHubResultV3(group));
  assert.throws(() => assertWorkflowHubResultV3({ version: 4, outcome: "completed", providers: [] }), { code: "PROTOCOL_INCOMPATIBLE" });
});

test("v3 derives public timing from broker attempts when the execution envelope omits it", () => {
  const member = projectWorkflowHubMemberV3({
    provider: "pi/k3", adapter: "pi", status: "failed", output: null,
    error: { code: "PROCESS_TIMEOUT", message: "provider process exceeded its review deadline" },
  }, context);
  assert.deepEqual(member.timing, { started_at_ms: 100, completed_at_ms: 121, duration_ms: 21 });
});

test("v3 rejects private paths and mixed-version member projections", () => {
  for (const message of ["/private/secret", "/workspace/secret", "/srv/review/subject.md"]) {
    assert.throws(() => projectWorkflowHubMemberV3({
      provider: "pi/k3", adapter: "pi", status: "failed", output: null,
      error: { code: "PROCESS_EXIT_NONZERO", message },
    }, context), { code: "PUBLIC_RESULT_INVALID" });
  }
  assert.throws(() => createWorkflowHubResultV3({ ...context, providers: [{ result_protocol: "workflowhub-result.v2" }] }), { code: "PROTOCOL_INCOMPATIBLE" });
});

test("v3 allows slash notation that follows a Unicode word", () => {
  assert.doesNotThrow(() => projectWorkflowHubMemberV3({
    provider: "pi/k3", adapter: "pi", status: "completed",
    output: JSON.stringify({ findings: [{ issue: "代码/AC/oracle/接口变化需要重新绑定事实" }] }),
  }, context));
});

test("v3 rejects untyped usage, invalid provenance hashes, and inconsistent recovery facts", () => {
  assert.throws(() => projectWorkflowHubMemberV3({ provider: "pi/k3", adapter: "pi", status: "failed", output: null, usage: [] }, context), { code: "PUBLIC_RESULT_INVALID" });
  assert.throws(() => projectWorkflowHubMemberV3({ provider: "pi/k3", adapter: "pi", status: "failed", output: null }, { ...context, raw_output_sha256: "not-a-sha" }), { code: "PUBLIC_RESULT_INVALID" });
  assert.throws(() => projectWorkflowHubMemberV3({ provider: "pi/k3", adapter: "pi", status: "failed", output: null }, { ...context, attempts: [{ kind: "initial", status: "failed", provider_retry_count: -1 }] }), { code: "PUBLIC_RESULT_INVALID" });
});

test("v3 does not misclassify a fresh execution recovery as provider-internal retry", () => {
  const member = projectWorkflowHubMemberV3({
    provider: "pi/k3", adapter: "pi", status: "completed", output: "ok", retry: { count: 1 },
  }, { ...context, attempts: [
    { attempt_id: "initial", kind: "initial", status: "failed", started_at_ms: 100, completed_at_ms: 110, duration_ms: 10, session_id: null, error: { code: "PROCESS_DEAD", message: "dead" }, provider_retry_count: 0 },
    { attempt_id: "fresh", kind: "fresh_execution", status: "completed", started_at_ms: 111, completed_at_ms: 121, duration_ms: 10, session_id: null, error: null, provider_retry_count: 0 },
  ] });
  assert.deepEqual(member.recovery, { provider_internal_retry_count: 0, fresh_execution_retry_count: 1, same_session_repair_count: 0 });
});
