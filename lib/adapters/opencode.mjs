import path from "node:path";
import { invalid, jsonProgress, lines, nonempty, plan, restrictedFiles, writeFile } from "./shared.mjs";

function parse(stdout) { let session = null; let text = null; let usage = null; let done = false; for (const item of lines(stdout)) { session ??= nonempty(item.sessionID ?? item.session_id ?? item.session?.id); usage ??= item.usage ?? item.part?.tokens ?? null; text = nonempty(item.text ?? item.part?.text ?? item.message?.text ?? item.message?.content) ?? text; done ||= ["step_finish", "session.completed", "runner.completed"].includes(item.type); } return text && done ? { ok: true, text, session_id: session, usage } : invalid("OpenCode emitted no completed final message"); }
function profile(runtime, provider) { const root = restrictedFiles(runtime, provider); const file = path.join(root, "opencode.json"); writeFile(file, `${JSON.stringify({ "$schema": "https://opencode.ai/config.json", agent: { "third-review-readonly": { description: "Read-only review", mode: "primary", permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" } } } })}\n`); return file; }
const reviewInstruction = "Review the complete content provided on stdin and return only the requested review.";

export default {
  capabilities: { continuation: true, attachment_delivery: ["always_embed"] },
  promptViaStdin: true,
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  // OpenCode exposes raw JSON events, not JSONL. It may still be silent while
  // reasoning, so process liveness is supervised independently of this stream.
  start(provider, cwd, prompt, runtime) { const config = profile(runtime, provider); const argv = ["run", "--pure", "--dir", cwd, "--format", "json"]; if (provider.model) argv.push("--model", provider.model); if (provider.effort) argv.push("--variant", provider.effort); argv.push("--agent", "third-review-readonly", reviewInstruction); return { ...plan(provider, cwd, argv, prompt, { OPENCODE_CONFIG: config, OPENCODE_DISABLE_CLAUDE_CODE: "1" }), observeLine: jsonProgress }; },
  resume(provider, cwd, session, prompt, runtime) { const config = profile(runtime, provider); const argv = ["run", "--session", session, "--pure", "--dir", cwd, "--format", "json"]; if (provider.model) argv.push("--model", provider.model); if (provider.effort) argv.push("--variant", provider.effort); argv.push("--agent", "third-review-readonly", reviewInstruction); return plan(provider, cwd, argv, prompt, { OPENCODE_CONFIG: config, OPENCODE_DISABLE_CLAUDE_CODE: "1" }); }, parse,
};
