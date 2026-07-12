import { ProtocolError } from "../protocol.mjs";

const BASE_ENV = ["PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR"];
const CLAUDE_DENY = ["Agent", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree", "ExitWorktree", "Monitor", "NotebookEdit", "PushNotification", "ReportFindings", "ScheduleWakeup", "SendMessage", "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch", "WebFetch", "WebSearch", "Workflow", "Write"].join(",");

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new ProtocolError("CONFIG_INVALID", `${name} must be a non-empty string`);
  return value;
}

function environment(ctx, extra = []) {
  const source = ctx.env ?? process.env;
  const selected = {};
  for (const name of new Set([...BASE_ENV, ...extra])) {
    if (typeof source[name] === "string") selected[name] = source[name];
  }
  selected.THIRD_REVIEW_ACTIVE = "1";
  return selected;
}

function directPlan(ctx, argv, { input = ctx.input, environmentNames = [] } = {}) {
  const source = ctx.env ?? process.env;
  return {
    kind: "cli", command: required(ctx.command, "command"), argv, cwd: required(ctx.cwd, "cwd"),
    env: environment(ctx, [...(ctx.auth_env ?? []), ...environmentNames]), input, shell: false,
    redact_values: (ctx.auth_env ?? []).map((name) => source[name]).filter((value) => typeof value === "string" && value.length > 0),
  };
}

function probe(ctx) { return directPlan(ctx, ["--version"], { input: null }); }

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function incomplete() { return { text: null, session_id: null, usage: null, error_code: "PROVIDER_PROTOCOL_INCOMPLETE" }; }

function json(value) { try { return JSON.parse(value); } catch { return null; } }

function lines(value) {
  return value.split(/\r?\n/).map(json).filter(Boolean);
}

function parseClaude(stdout) {
  const output = json(stdout);
  const text = stringOrNull(output?.result);
  return text ? { text, session_id: stringOrNull(output.session_id), usage: output.modelUsage ?? output.usage ?? null, error_code: null } : incomplete();
}

function parseKimi(stdout) {
  const resumeSession = stdout.match(/(?:kimi\s+-r|--resume)\s+([A-Za-z0-9_-]+)/)?.[1] ?? null;
  let session = resumeSession;
  let text = null; let usage = null;
  for (const event of lines(stdout)) {
    session ??= stringOrNull(event.session_id ?? event.sessionId);
    usage ??= event.usage ?? null;
    if (["final", "result", "message.completed"].includes(event.type) || event.role === "assistant") {
      text = stringOrNull(event.text ?? event.result ?? event.content ?? event.message?.content) ?? text;
    }
  }
  const terminal = Boolean(resumeSession) || lines(stdout).some((event) => ["final", "result", "message.completed"].includes(event.type));
  return text && terminal ? { text, session_id: session, usage, error_code: null } : incomplete();
}

function parseCodex(stdout) {
  let session = null; let text = null; let usage = null; let terminal = false;
  for (const event of lines(stdout)) {
    if (event.type === "thread.started") session ??= stringOrNull(event.thread_id ?? event.threadId);
    usage ??= event.usage ?? null;
    if (event.type === "item.completed" && event.item?.type === "agent_message") text ??= stringOrNull(event.item.text ?? event.item.content);
    terminal ||= event.type === "turn.completed" || event.type === "thread.completed" || event.type === "session.completed";
  }
  return text && terminal ? { text, session_id: session, usage, error_code: null } : incomplete();
}

function parseOpenCode(stdout) {
  const events = lines(stdout);
  let session = null; let text = null; let usage = null; let terminal = false;
  for (const event of events) {
    session ??= stringOrNull(event.sessionID ?? event.session_id ?? event.session?.id);
    usage ??= event.usage ?? event.part?.tokens ?? null;
    text = stringOrNull(event.text ?? event.part?.text ?? event.message?.text ?? event.message?.content) ?? text;
    terminal ||= event.type === "step_finish" || event.type === "session.completed";
  }
  return text && terminal ? { text, session_id: session, usage, error_code: null } : incomplete();
}

function withModel(argv, ctx) {
  if (ctx.model) argv.push("--model", required(ctx.model, "model"));
  return argv;
}

function verifiedCodexHome(ctx) {
  const home = ctx.env?.CODEX_HOME;
  if (ctx.codex_isolation_verified !== true || typeof home !== "string" || home.length === 0) {
    throw new ProtocolError("UNSUPPORTED", "Codex temporary auth/profile isolation is not verified");
  }
  return home;
}

const claudeCode = {
  id: "claude-code",
  probe(ctx) { return directPlan(ctx, ["--help"], { input: null }); },
  parseProbe(stdout) {
    if (typeof stdout !== "string" || !stdout.includes("--allowedTools") || !stdout.includes("--safe-mode")) {
      throw new ProtocolError("UNSUPPORTED", "Claude Code does not advertise the required read-only profile flags");
    }
    return true;
  },
  buildStart(ctx) {
    const argv = withModel(["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--safe-mode", "--disable-slash-commands", "--allowedTools", "Read"], ctx);
    if (ctx.effort) argv.push("--effort", required(ctx.effort, "effort"));
    argv.push("--disallowedTools", CLAUDE_DENY);
    return directPlan(ctx, argv);
  },
  buildResume(ctx) {
    required(ctx.session_id, "session_id");
    const plan = this.buildStart({ ...ctx, input: null });
    plan.argv.unshift("--resume", ctx.session_id);
    plan.argv.splice(plan.argv.indexOf("--disallowedTools"), 0, required(ctx.resume_input, "resume_input"));
    return plan;
  },
  parse: parseClaude,
};

const kimi = {
  id: "kimi",
  probe,
  buildStart(ctx) {
    const argv = ["--print", "--input-format", "text", "--output-format", "stream-json", "--final-message-only", "--work-dir", required(ctx.cwd, "cwd")];
    if (ctx.model) argv.push("--model", required(ctx.model, "model"));
    if (ctx.thinking === true) argv.push("--thinking");
    if (ctx.thinking === false) argv.push("--no-thinking");
    argv.push("--agent-file", required(ctx.profile_path, "profile_path"));
    return directPlan(ctx, argv);
  },
  buildResume(ctx) {
    required(ctx.session_id, "session_id");
    const plan = this.buildStart({ ...ctx, input: required(ctx.resume_input, "resume_input") });
    plan.argv.push("--session", ctx.session_id);
    return plan;
  },
  parse: parseKimi,
};

const codex = {
  id: "codex",
  probe(ctx) {
    verifiedCodexHome(ctx);
    return directPlan(ctx, ["--version"], { input: null, environmentNames: ["CODEX_HOME"] });
  },
  buildStart(ctx) {
    verifiedCodexHome(ctx);
    const argv = ["exec", "-C", required(ctx.cwd, "cwd"), "-s", "read-only"];
    if (ctx.model) argv.push("-m", required(ctx.model, "model"));
    argv.push("--json", "-");
    return directPlan(ctx, argv, { environmentNames: ["CODEX_HOME"] });
  },
  buildResume(ctx) {
    throw new ProtocolError("UNSUPPORTED", "Codex exec resume lacks an independently verified read-only profile");
  },
  parse: parseCodex,
};

const opencode = {
  id: "opencode",
  probe,
  buildStart(ctx) {
    const argv = ["run", "--pure", "--dir", required(ctx.cwd, "cwd"), "--format", "json"];
    if (ctx.model) argv.push("--model", required(ctx.model, "model"));
    if (ctx.effort) argv.push("--variant", required(ctx.effort, "effort"));
    argv.push("--agent", required(ctx.profile_name, "profile_name"));
    argv.push(required(ctx.input, "input"));
    return directPlan(ctx, argv, { input: null });
  },
  buildResume(ctx) {
    required(ctx.session_id, "session_id");
    const argv = ["run", "--session", ctx.session_id, "--pure", "--dir", required(ctx.cwd, "cwd"), "--format", "json"];
    if (ctx.model) argv.push("--model", required(ctx.model, "model"));
    if (ctx.effort) argv.push("--variant", required(ctx.effort, "effort"));
    argv.push("--agent", required(ctx.profile_name, "profile_name"), required(ctx.resume_input, "resume_input"));
    return directPlan(ctx, argv, { input: null });
  },
  parse: parseOpenCode,
};

export const adapters = Object.freeze({ "claude-code": claudeCode, kimi, codex, opencode });

export function getAdapter(id) {
  const adapter = adapters[id];
  if (!adapter) throw new ProtocolError("UNSUPPORTED", `unsupported provider adapter: ${id}`);
  return adapter;
}

export function parseTerminal(id, stdout) {
  if (typeof stdout !== "string") throw new ProtocolError("REQUEST_INVALID", "stdout must be text");
  return getAdapter(id).parse(stdout);
}
