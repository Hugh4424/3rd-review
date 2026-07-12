import { directPlan, incomplete, lines, required, stringOrNull } from "./shared.mjs";

function parse(stdout) {
  let session = null; let text = null; let usage = null; let terminal = false;
  for (const event of lines(stdout)) {
    if (event.type === "thread.started") session ??= stringOrNull(event.thread_id ?? event.threadId);
    usage ??= event.usage ?? null;
    if (event.type === "item.completed" && event.item?.type === "agent_message") text ??= stringOrNull(event.item.text ?? event.item.content);
    terminal ||= event.type === "turn.completed" || event.type === "thread.completed" || event.type === "session.completed";
  }
  return text && terminal ? { text, session_id: session, usage, error_code: null } : incomplete();
}

export const codex = {
  id: "codex",
  probe: (ctx) => directPlan(ctx, ["--version"], { input: null }),
  buildStart(ctx) { const argv = ["exec", "-C", required(ctx.cwd, "cwd"), "-s", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]; if (ctx.model) argv.push("-m", required(ctx.model, "model")); argv.push("--json", "-"); return directPlan(ctx, argv); },
  buildResume(ctx) { required(ctx.session_id, "session_id"); const argv = ["exec", "resume", ctx.session_id, "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]; if (ctx.model) argv.push("-m", required(ctx.model, "model")); argv.push("--json", "-"); return directPlan(ctx, argv, { input: required(ctx.resume_input, "resume_input") }); },
  parse,
};
