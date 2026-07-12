import { ProtocolError } from "../protocol.mjs";
import { claudeCode } from "./claude-code.mjs";
import { codex } from "./codex.mjs";
import { kimi } from "./kimi.mjs";
import { opencode } from "./opencode.mjs";

export function classifyFailure(output) {
  const text = String(output ?? "").toLowerCase();
  if (/unsupported|not supported|isolation.*not.*verified/.test(text)) return "UNSUPPORTED";
  if (/certificate verification|unable to verify|self[- ]signed certificate|unable to get local issuer/.test(text)) return "NETWORK_TLS_CERTIFICATE";
  if (/unauthorized|authentication failed|invalid api key|login required|not logged in|credential/.test(text)) return "AUTHENTICATION_FAILED";
  if (/rate limit|too many requests|quota exceeded/.test(text)) return "RATE_LIMITED";
  if (/permission denied|operation not permitted|not allowed to (access|read|open)/.test(text)) return "PROVIDER_PERMISSION_DENIED";
  if (/enotfound|econnrefused|econnreset|network is unreachable|network error|timed out|timeout/.test(text)) return "NETWORK_UNAVAILABLE";
  return "PROCESS_EXIT_NONZERO";
}

export const adapters = Object.freeze({ "claude-code": claudeCode, kimi, codex, opencode });
export function getAdapter(id) { const adapter = adapters[id]; if (!adapter) throw new ProtocolError("UNSUPPORTED", `unsupported provider adapter: ${id}`); return adapter; }
export function parseTerminal(id, stdout) { if (typeof stdout !== "string") throw new ProtocolError("REQUEST_INVALID", "stdout must be text"); return getAdapter(id).parse(stdout); }
