import assert from "node:assert/strict";
import test from "node:test";

import { adapters, parseTerminal } from "../../lib/v3/adapters/index.mjs";

const context = {
  command: "/usr/local/bin/reviewer", cwd: "/tmp/package", input: "review this bounded package",
  model: "test-model", effort: "low", env: { HOME: "/Users/test", CODEX_HOME: "/tmp/codex-auth", PATH: "/usr/bin", SECRET: "hidden" },
  profile_path: "/tmp/profile.yaml", profile_name: "third-review-readonly", session_id: "native_session_1", resume_input: "continue with the repair request", codex_isolation_verified: true,
};

test("all built-in adapters use a direct CLI plan and retain only declared environment names", () => {
  for (const [id, adapter] of Object.entries(adapters)) {
    const probe = adapter.probe(context);
    assert.deepEqual(probe.argv, id === "claude-code" ? ["--help"] : ["--version"], id);
    assert.equal(probe.input, null, id);
    const plan = adapter.buildStart(context);
    assert.equal(plan.kind, "cli", id);
    assert.equal(plan.command, context.command, id);
    assert.equal(plan.shell, false, id);
    assert.equal(plan.env.HOME, "/Users/test", id);
    assert.equal(plan.env.PATH, "/usr/bin", id);
    assert.equal(plan.env.SECRET, undefined, id);
    assert.deepEqual(plan.redact_values, [], id);
    assert.equal(plan.env.THIRD_REVIEW_ACTIVE, "1", id);
    assert.equal(plan.env.CODEX_HOME, id === "codex" ? "/tmp/codex-auth" : undefined, id);
    assert.equal(plan.argv.includes("--bare"), false, id);
    assert.equal(plan.argv.includes("--plan"), false, id);
  }
});

test("declared authentication environment values are retained only for execution-time redaction", () => {
  const plan = adapters.kimi.buildStart({ ...context, auth_env: ["REVIEW_TOKEN"], env: { ...context.env, REVIEW_TOKEN: "private-token" } });
  assert.equal(plan.env.REVIEW_TOKEN, "private-token");
  assert.deepEqual(plan.redact_values, ["private-token"]);
});

test("Claude Code profile is non-interactive read-only and resumes only its own native session", () => {
  const adapter = adapters["claude-code"];
  const start = adapter.buildStart(context);
  assert.deepEqual(start.argv.slice(0, 9), ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--safe-mode", "--disable-slash-commands", "--allowedTools", "Read"]);
  assert.equal(start.argv.includes("--resume"), false);
  assert.equal(start.argv.includes("--allowedTools"), true);
  assert.equal(start.argv.includes("Read"), true);
  const resumed = adapter.buildResume(context);
  assert.deepEqual(resumed.argv.slice(0, 11), ["--resume", context.session_id, "-p", "--output-format", "json", "--permission-mode", "dontAsk", "--safe-mode", "--disable-slash-commands", "--allowedTools", "Read"]);
  assert.equal(resumed.argv.indexOf(context.resume_input) < resumed.argv.indexOf("--disallowedTools"), true);
  assert.equal(resumed.argv.at(-1), "Agent,Bash,CronCreate,CronDelete,CronList,DesignSync,Edit,EnterWorktree,ExitWorktree,Monitor,NotebookEdit,PushNotification,ReportFindings,ScheduleWakeup,SendMessage,Task,TaskCreate,TaskGet,TaskList,TaskOutput,TaskStop,TaskUpdate,ToolSearch,WebFetch,WebSearch,Workflow,Write");
  assert.equal(resumed.input, null);
});

test("Claude Code probe rejects a CLI that does not advertise the read-only allowlist", () => {
  assert.equal(adapters["claude-code"].parseProbe("--safe-mode\n--allowedTools <tools...>"), true);
  assert.throws(() => adapters["claude-code"].parseProbe("--safe-mode"), { code: "UNSUPPORTED" });
});

test("machine output parsers return final text and native session or report incomplete transport", () => {
  assert.deepEqual(parseTerminal("claude-code", JSON.stringify({ result: "done", session_id: "c1", modelUsage: { input_tokens: 1 } })), {
    text: "done", session_id: "c1", usage: { input_tokens: 1 }, error_code: null,
  });
  assert.deepEqual(parseTerminal("kimi", '{"role":"assistant","content":"partial"}\n{"role":"assistant","content":"done"}\n\nTo resume this session: kimi -r k1\n'), {
    text: "done", session_id: "k1", usage: null, error_code: null,
  });
  assert.deepEqual(parseTerminal("codex", '{"type":"thread.started","thread_id":"x1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed"}\n'), {
    text: "done", session_id: "x1", usage: null, error_code: null,
  });
  assert.deepEqual(parseTerminal("opencode", `${JSON.stringify({ type: "text", sessionID: "o1", part: { text: "partial" } })}\n${JSON.stringify({ type: "text", sessionID: "o1", part: { text: "done" } })}\n${JSON.stringify({ type: "step_finish", sessionID: "o1" })}\n`), {
    text: "done", session_id: "o1", usage: null, error_code: null,
  });
  assert.equal(parseTerminal("claude-code", "").error_code, "PROVIDER_PROTOCOL_INCOMPLETE");
  assert.equal(parseTerminal("kimi", '{"role":"assistant","content":"partial"}\n').error_code, "PROVIDER_PROTOCOL_INCOMPLETE");
  assert.equal(parseTerminal("opencode", JSON.stringify({ type: "text", sessionID: "o1", part: { text: "partial" } })).error_code, "PROVIDER_PROTOCOL_INCOMPLETE");
  assert.equal(parseTerminal("codex", '{"type":"thread.started","thread_id":"x1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n').error_code, "PROVIDER_PROTOCOL_INCOMPLETE");
});

test("Kimi and OpenCode reject a start plan without their read-only profile", () => {
  assert.throws(() => adapters.kimi.buildStart({ ...context, profile_path: null }), { code: "CONFIG_INVALID" });
  assert.throws(() => adapters.opencode.buildStart({ ...context, profile_name: null }), { code: "CONFIG_INVALID" });
  assert.throws(() => adapters.codex.buildStart({ ...context, codex_isolation_verified: false }), { code: "UNSUPPORTED" });
  assert.throws(() => adapters.codex.buildStart({ ...context, env: { HOME: "/Users/test", PATH: "/usr/bin" } }), { code: "UNSUPPORTED" });
  assert.throws(() => adapters.codex.probe({ ...context, codex_isolation_verified: false }), { code: "UNSUPPORTED" });
  assert.throws(() => adapters.codex.probe({ ...context, env: { HOME: "/Users/test", PATH: "/usr/bin" } }), { code: "UNSUPPORTED" });
  assert.throws(() => adapters.codex.buildResume(context), { code: "UNSUPPORTED" });
  assert.throws(() => adapters.codex.buildResume({ ...context, codex_isolation_verified: false }), { code: "UNSUPPORTED" });
  assert.equal(adapters.opencode.buildStart(context).argv.includes("--pure"), true);
  const openCodeResume = adapters.opencode.buildResume(context);
  assert.equal(openCodeResume.argv.includes(context.input), false);
  assert.equal(openCodeResume.argv.includes(context.resume_input), true);
  const kimiResume = adapters.kimi.buildResume(context);
  assert.equal(kimiResume.input, context.resume_input);
  assert.equal(kimiResume.argv.includes(context.session_id), true);
});
