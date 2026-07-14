import { invalid, jsonProgress, lines, nonempty, plan } from "./shared.mjs";

function parse(stdout) { let session = null; let text = null; let usage = null; let done = false; for (const item of lines(stdout)) { session ??= nonempty(item.sessionID ?? item.session_id ?? item.session?.id); usage ??= item.usage ?? item.part?.tokens ?? null; text = nonempty(item.text ?? item.part?.text ?? item.message?.text ?? item.message?.content) ?? text; done ||= ["step_finish", "session.completed", "runner.completed"].includes(item.type); } return text && done ? { ok: true, text, session_id: session, usage } : invalid("OpenCode emitted no completed final message"); }
const reviewInstruction = "Review only the supplied instruction and files in the current isolated attachment workspace. Do not use git, shell, network, host paths, or any files outside this workspace. Return only the requested review.";

export default {
  capabilities: { continuation: true, attachment_delivery: ["file_only", "always_embed"] },
  requiresWritableCwd: true,
  promptViaStdin: true,
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  // OpenCode exposes raw JSON events, not JSONL. It may still be silent while
  // reasoning, so process liveness is supervised independently of this stream.
  // Sandbox policy, not a provider-visible profile, is the access boundary.
  // Keep provider configuration out of both the attachment workspace and argv.
  start(provider, cwd, prompt) { const argv = ["run", "--pure", "--dir", cwd, "--format", "json"]; if (provider.model) argv.push("--model", provider.model); if (provider.effort) argv.push("--variant", provider.effort); argv.push(reviewInstruction); return { ...plan(provider, cwd, argv, prompt, { OPENCODE_DISABLE_CLAUDE_CODE: "1" }), observeLine: jsonProgress }; },
  resume(provider, cwd, session, prompt) { const argv = ["run", "--session", session, "--pure", "--dir", cwd, "--format", "json"]; if (provider.model) argv.push("--model", provider.model); if (provider.effort) argv.push("--variant", provider.effort); argv.push(reviewInstruction); return plan(provider, cwd, argv, prompt, { OPENCODE_DISABLE_CLAUDE_CODE: "1" }); }, parse,
};
