import { ProtocolError } from "../protocol.mjs";

export const BASE_ENV = ["PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR"];
export const CLAUDE_DENY = ["Agent", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree", "ExitWorktree", "Monitor", "NotebookEdit", "PushNotification", "ReportFindings", "ScheduleWakeup", "SendMessage", "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch", "WebFetch", "WebSearch", "Workflow", "Write"].join(",");

export function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new ProtocolError("CONFIG_INVALID", `${name} must be a non-empty string`);
  return value;
}

function environment(ctx, extra = []) {
  const source = ctx.env ?? process.env;
  const selected = {};
  for (const name of new Set([...BASE_ENV, ...extra])) if (typeof source[name] === "string") selected[name] = source[name];
  for (const [name, value] of Object.entries(ctx.runtime_env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof value !== "string" || value.length === 0) {
      throw new ProtocolError("CONFIG_INVALID", "runtime environment must contain non-empty environment values");
    }
    selected[name] = value;
  }
  selected.THIRD_REVIEW_ACTIVE = "1";
  return selected;
}

export function directPlan(ctx, argv, { input = ctx.input, environmentNames = [] } = {}) {
  const source = ctx.env ?? process.env;
  return {
    kind: "cli", command: required(ctx.command, "command"), argv, cwd: required(ctx.cwd, "cwd"),
    env: environment(ctx, [...(ctx.auth_env ?? []), ...(ctx.env_allowlist ?? []), ...environmentNames]), input, shell: false,
    redact_values: (ctx.auth_env ?? []).map((name) => source[name]).filter((value) => typeof value === "string" && value.length > 0),
  };
}

export function probe(ctx) { return directPlan(ctx, ["--version"], { input: null }); }
export function stringOrNull(value) { return typeof value === "string" && value.trim().length > 0 ? value : null; }
export function incomplete() { return { text: null, session_id: null, usage: null, error_code: "PROVIDER_PROTOCOL_INCOMPLETE" }; }
export function json(value) { try { return JSON.parse(value); } catch { return null; } }
export function lines(value) { return value.split(/\r?\n/).map(json).filter(Boolean); }
export function withModel(argv, ctx) { if (ctx.model) argv.push("--model", required(ctx.model, "model")); return argv; }
