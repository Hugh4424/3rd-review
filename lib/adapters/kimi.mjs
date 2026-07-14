import fs from "node:fs";
import path from "node:path";
import { invalid, lines, nonempty, plan, writeFile } from "./shared.mjs";

function assistantText(value) {
  if (typeof value === "string") return nonempty(value);
  if (!Array.isArray(value)) return null;
  const blocks = value.filter((block) => block && block.type === "text").map((block) => nonempty(block.text)).filter(Boolean);
  return blocks.length ? blocks.join("\n") : null;
}

function parse(stdout, stderr = "") {
  const combined = `${stdout}\n${stderr}`;
  // Kimi writes this exact final hint to stderr. Do not search arbitrary model
  // text: a reviewer can legitimately quote `kimi -r example` in its answer.
  let session = combined.match(/^To resume this session:\s*kimi\s+-r\s+([0-9a-f]{8}-[0-9a-f-]{27,})\s*$/mi)?.[1] ?? null; let text = null; let usage = null; let terminal = false;
  for (const item of lines(stdout)) {
    session ??= nonempty(item.session_id ?? item.sessionId); usage ??= item.usage ?? null;
    if (["final", "result", "message.completed"].includes(item.type)) terminal = true;
    if (["final", "result", "message.completed"].includes(item.type) || item.role === "assistant") text = nonempty(item.text ?? item.result) ?? assistantText(item.content ?? item.message?.content) ?? text;
  }
  // The CLI's explicit resume hint is terminal evidence; arbitrary reviewer
  // text is not enough to fabricate a resumable session.
  return text && (terminal || session !== null) ? { ok: true, text, session_id: session, usage } : invalid("Kimi emitted no terminal final message");
}

function profile(cwd) {
  const root = path.join(cwd, ".broker-profile"); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); const bundle = path.resolve(cwd, "bundle"); const attached = fs.existsSync(bundle) ? " The complete frozen review bundle is available only below the provider-visible attachment workspace. Read review-packet.v1.json, contracts, and skills through to the end. Never output or request host paths, never access any path outside this workspace, and do not seek or use a shell." : ""; const prompt = `You are a read-only independent reviewer. Do not modify files, execute commands, access the network, or delegate. Review only the supplied prompt and attached workspace. Read and apply attached skills when relevant, but never use skills outside this private workspace.${attached}\n`;
  writeFile(path.join(root, "reviewer.md"), prompt);
  writeFile(path.join(root, "reviewer.yaml"), "version: 1\nagent:\n  name: third-review-readonly\n  system_prompt_path: ./reviewer.md\n  tools:\n    - kimi_cli.tools.file:ReadFile\n    - kimi_cli.tools.file:Glob\n    - kimi_cli.tools.file:Grep\n");
  const bundleSkills = path.join(bundle, "skills");
  return { file: path.join(root, "reviewer.yaml"), workDir: cwd, skills: fs.existsSync(bundleSkills) ? bundleSkills : path.join(cwd, "skills") };
}

function observeLine(stream, line) {
  const retry_count = (line.match(/APIEmptyResponseError/g) ?? []).length;
  if (stream !== "stdout") return { retry_count, progress: false };
  try { JSON.parse(line); return { retry_count, progress: true, event: "stream-json" }; }
  catch { return { retry_count, progress: false }; }
}

export default {
  capabilities: { continuation: true, attachment_delivery: ["file_only"] },
  requiresWritableCwd: true,
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  start(provider, cwd, prompt) { const p = profile(cwd); const argv = ["--print", "--input-format", "text", "--output-format", "stream-json", "--work-dir", p.workDir, "--agent-file", p.file, "--skills-dir", p.skills]; if (provider.model) argv.push("--model", provider.model); if (provider.thinking === true) argv.push("--thinking"); if (provider.thinking === false) argv.push("--no-thinking"); return { ...plan(provider, cwd, argv, prompt), observeLine }; },
  resume(provider, cwd, session, prompt) { const next = this.start(provider, cwd, prompt); next.argv.push("--session", session); return next; }, parse,
};
