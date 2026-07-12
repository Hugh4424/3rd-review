import { fail } from "../errors.mjs";
import claudeCode from "./claude-code.mjs";
import codex from "./codex.mjs";
import kimi from "./kimi.mjs";
import opencode from "./opencode.mjs";

const registry = { "claude-code": claudeCode, codex, kimi, opencode };
export function adapter(id) { if (!registry[id]) fail("UNSUPPORTED_PROVIDER", `no adapter for ${id}`); return registry[id]; }
export function failureCode(text) { const value = String(text).toLowerCase(); if (/unauthorized|authentication failed|invalid api key|login required|not logged in|credential/.test(value)) return "AUTHENTICATION_FAILED"; if (/certificate verification|unable to verify|self[- ]signed/.test(value)) return "NETWORK_TLS_CERTIFICATE"; if (/rate limit|too many requests|quota exceeded/.test(value)) return "RATE_LIMITED"; if (/enotfound|econnrefused|econnreset|network is unreachable|network error/.test(value)) return "NETWORK_UNAVAILABLE"; if (/permission denied|operation not permitted/.test(value)) return "PROVIDER_PERMISSION_DENIED"; return "PROCESS_EXIT_NONZERO"; }
