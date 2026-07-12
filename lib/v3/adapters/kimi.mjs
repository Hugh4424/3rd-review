import { directPlan, incomplete, lines, required, stringOrNull } from "./shared.mjs";

function parse(stdout) {
  const resumeSession = stdout.match(/(?:kimi\s+-r|--resume)\s+([A-Za-z0-9_-]+)/)?.[1] ?? null;
  let session = resumeSession; let text = null; let usage = null;
  for (const event of lines(stdout)) {
    session ??= stringOrNull(event.session_id ?? event.sessionId); usage ??= event.usage ?? null;
    if (["final", "result", "message.completed"].includes(event.type) || event.role === "assistant") text = stringOrNull(event.text ?? event.result ?? event.content ?? event.message?.content) ?? text;
  }
  const terminal = Boolean(resumeSession) || lines(stdout).some((event) => ["final", "result", "message.completed"].includes(event.type));
  return text && terminal ? { text, session_id: session, usage, error_code: null } : incomplete();
}

export const kimi = {
  id: "kimi",
  probe: (ctx) => directPlan(ctx, ["--version"], { input: null }),
  buildStart(ctx) {
    const argv = ["--print", "--input-format", "text", "--output-format", "stream-json", "--final-message-only", "--work-dir", required(ctx.cwd, "cwd")];
    if (ctx.model) argv.push("--model", required(ctx.model, "model"));
    if (ctx.thinking === true) argv.push("--thinking"); if (ctx.thinking === false) argv.push("--no-thinking");
    argv.push("--agent-file", required(ctx.profile_path, "profile_path"), "--skills-dir", required(ctx.skills_dir, "skills_dir"));
    return directPlan(ctx, argv);
  },
  buildResume(ctx) { required(ctx.session_id, "session_id"); const plan = this.buildStart({ ...ctx, input: required(ctx.resume_input, "resume_input") }); plan.argv.push("--session", ctx.session_id); return plan; },
  parse,
};
