import { directPlan, incomplete, lines, required, stringOrNull } from "./shared.mjs";

function parse(stdout) {
  const events = lines(stdout); let session = null; let text = null; let usage = null; let terminal = false;
  for (const event of events) {
    session ??= stringOrNull(event.sessionID ?? event.session_id ?? event.session?.id); usage ??= event.usage ?? event.part?.tokens ?? null;
    text = stringOrNull(event.text ?? event.part?.text ?? event.message?.text ?? event.message?.content) ?? text;
    terminal ||= event.type === "step_finish" || event.type === "session.completed";
  }
  return text && terminal ? { text, session_id: session, usage, error_code: null } : incomplete();
}

export const opencode = {
  id: "opencode",
  probe: (ctx) => directPlan(ctx, ["--version"], { input: null }),
  buildStart(ctx) { const argv = ["run", "--pure", "--dir", required(ctx.cwd, "cwd"), "--format", "json"]; if (ctx.model) argv.push("--model", required(ctx.model, "model")); if (ctx.effort) argv.push("--variant", required(ctx.effort, "effort")); argv.push("--agent", required(ctx.profile_name, "profile_name"), required(ctx.input, "input")); return directPlan(ctx, argv, { input: null }); },
  buildResume(ctx) { required(ctx.session_id, "session_id"); const argv = ["run", "--session", ctx.session_id, "--pure", "--dir", required(ctx.cwd, "cwd"), "--format", "json"]; if (ctx.model) argv.push("--model", required(ctx.model, "model")); if (ctx.effort) argv.push("--variant", required(ctx.effort, "effort")); argv.push("--agent", required(ctx.profile_name, "profile_name"), required(ctx.resume_input, "resume_input")); return directPlan(ctx, argv, { input: null }); },
  parse,
};
