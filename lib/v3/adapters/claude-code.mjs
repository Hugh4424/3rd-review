import { ProtocolError } from "../protocol.mjs";
import { CLAUDE_DENY, directPlan, incomplete, json, required, stringOrNull, withModel } from "./shared.mjs";

function parse(stdout) {
  const output = json(stdout);
  const text = stringOrNull(output?.result);
  return text ? { text, session_id: stringOrNull(output.session_id), usage: output.modelUsage ?? output.usage ?? null, error_code: null } : incomplete();
}

export const claudeCode = {
  id: "claude-code",
  probe(ctx) { return directPlan(ctx, ["--help"], { input: null }); },
  parseProbe(stdout) {
    if (typeof stdout !== "string" || !stdout.includes("--allowedTools") || !stdout.includes("--safe-mode")) throw new ProtocolError("UNSUPPORTED", "Claude Code does not advertise the required read-only profile flags");
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
  parse,
};
