#!/usr/bin/env node
// extract-codex-meta.mjs extracts review runtime metadata from Codex rollout files.
// Usage: node extract-codex-meta.mjs <reviewRequestId> [--repo-root=<path>] [--task-dir=<path>] [--git-sha=<sha>] [sessionsRoot]
// Output: JSON with auth, model, reasoning effort, token usage, subreviewer state, and elapsed time.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Parse CLI args — support positional reviewRequestId + optional flags + optional sessionsRoot
let reqId = null;
let repoRoot = null;
let taskDir = null;
let expectedGitSha = null;
let sessionsRoot = null;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--repo-root=")) repoRoot = arg.slice("--repo-root=".length);
  else if (arg.startsWith("--task-dir=")) taskDir = arg.slice("--task-dir=".length);
  else if (arg.startsWith("--git-sha=")) expectedGitSha = arg.slice("--git-sha=".length);
  else if (!reqId) reqId = arg;
  else sessionsRoot = arg;
}
sessionsRoot = sessionsRoot || path.join(os.homedir(), ".codex", "sessions");
if (!reqId) { console.error("usage: extract-codex-meta.mjs <reviewRequestId> [--repo-root=<path>] [--task-dir=<path>] [--git-sha=<sha>] [sessionsRoot]"); process.exit(1); }

// 1. Auth source (~/.codex/auth.json)
function getAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8"));
    const mode = a.auth_mode || (a.tokens ? "chatgpt_login" : (a.OPENAI_API_KEY ? "api_key" : "unknown"));
    if (mode === "chatgpt_login" || a.tokens) {
      return { method: "chatgpt_login", account: a.account_id || (a.tokens && a.tokens.account_id) || "(unknown)" };
    }
    const key = a.OPENAI_API_KEY || "";
    return { method: "api_key", base_url: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1", key_masked: key ? key.slice(0, 7) + "***" + key.slice(-4) : "(none)" };
  } catch { return { method: "unknown" }; }
}

function assessBinding(text) {
  const matched = {
    reviewRequestId: text.includes(reqId),
    repoRoot: repoRoot ? text.includes(repoRoot) : null,
    taskDir: taskDir ? text.includes(taskDir) : null,
    gitSha: expectedGitSha ? text.includes(expectedGitSha) : null,
  };
  const requested = Object.entries({ repoRoot, taskDir, gitSha: expectedGitSha })
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
  const matchedRequested = requested.filter((key) => matched[key] === true);
  const missingRequested = requested.filter((key) => matched[key] !== true);
  const hasForeignRepo = Boolean(repoRoot) && /\/(Users|home)\/[^/\s]+\/[^/\s]*(multica|agenthub)[^\s"]*/.test(text) && !text.includes(repoRoot);

  let bindingStatus = "request_only";
  if (!matched.reviewRequestId) bindingStatus = "unbound";
  else if (missingRequested.length === 0 && requested.length > 0) bindingStatus = "exact";
  else if (matchedRequested.length > 0) bindingStatus = "partial";
  else if (requested.length > 0) bindingStatus = "mismatch";
  if (hasForeignRepo && bindingStatus !== "exact") bindingStatus = "mismatch";

  return { matched, requested, matchedRequested, missingRequested, hasForeignRepo, bindingStatus };
}

function scoreSessionText(text) {
  let score = text.includes(reqId) ? 1 : 0;
  if (text.includes(`"reviewRequestId":"${reqId}"`) || text.includes(`"subreviewerRequestId":"${reqId}"`)) score += 20;
  if (text.includes(`\\\"reviewRequestId\\\":\\\"${reqId}\\\"`) || text.includes(`\\\"subreviewerRequestId\\\":\\\"${reqId}\\\"`)) score += 20;

  const binding = assessBinding(text);
  if (binding.matched.repoRoot) score += 50;
  if (binding.matched.taskDir) score += 40;
  if (binding.matched.gitSha) score += 30;
  if (binding.bindingStatus === "exact") score += 200;
  if (binding.bindingStatus === "partial") score += 40;
  if (binding.bindingStatus === "mismatch") score -= 120;
  if (binding.hasForeignRepo) score -= 40;

  const lines = text.trim().split("\n");
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const p = j.payload || {};
    const candidates = [];
    if (typeof p.message === "string") candidates.push(p.message);
    if (Array.isArray(p.content)) {
      for (const item of p.content) if (typeof item?.text === "string") candidates.push(item.text);
    }
    for (const value of candidates) {
      try {
        const parsed = JSON.parse(value);
        // The final reviewer session is the ONLY authoritative source for _codexMeta
        // (model/effort/tokens). It is identified by emitting the final verdict JSON
        // (reviewRequestId + verdict). Subreviewer sessions carry the SAME reqId as
        // subreviewerRequestId, so without separating the scores they tie with the final
        // reviewer and the mtime tiebreak (line ~116) can pick a subreviewer session —
        // mis-attributing _codexMeta.model to the subreviewer model (e.g. gpt-5.4-mini).
        // Score the final-verdict session strictly higher so it always wins selection.
        if (parsed.reviewRequestId === reqId && parsed.verdict) {
          score += 5000;
        } else if (parsed.subreviewerRequestId === reqId && parsed.status) {
          score += 100;
        }
      } catch { /* not a direct JSON response */ }
    }
  }
  return { score, binding };
}

// 2. Find the best session file containing reqId.
function findSession() {
  const cutoff = Date.now() - 2 * 86400000;
  const hits = [];
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d); } catch { return; }
    for (const n of es) {
      const f = path.join(d, n); let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.isDirectory()) walk(f);
      else if (st.isFile() && n.startsWith("rollout-") && n.endsWith(".jsonl") && st.mtimeMs >= cutoff) {
        try {
          const text = fs.readFileSync(f, "utf8");
          const { score, binding } = scoreSessionText(text);
          if (score > 0) hits.push({ f, m: st.mtimeMs, score, binding });
        } catch {}
      }
    }
  };
  walk(sessionsRoot);
  hits.sort((a, b) => b.score - a.score || b.m - a.m);
  return hits[0] || null;
}

// 3. Parse the session file and summarize metadata.
function parseSession(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  let model = null, effort = null, cliVersion = null, provider = null;
  let firstTs = null, lastTs = null;
  let lastTokenInfo = null;
  let totalTokenInfo = null;
  const subreviewers = [];
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const ts = j.timestamp ? Date.parse(j.timestamp) : null;
    if (ts) { if (firstTs === null || ts < firstTs) firstTs = ts; if (lastTs === null || ts > lastTs) lastTs = ts; }
    const p = j.payload || {};
    if (j.type === "session_meta") { cliVersion = p.cli_version || cliVersion; provider = p.model_provider || provider; }
    if (j.type === "turn_context") {
      // Root cause: the original `effort = p.effort || ... || effort` had no guard, so a
      // LATER turn_context overwrote the real reviewer effort ("last wins"). The honest
      // source is the session's configured reasoning effort, set at the FIRST turn_context
      // of the selected (final-reviewer) session. Lock onto the first non-empty value and
      // never overwrite it, so the surfaced effort reflects the real reviewer turn — not a
      // later turn_context that may carry a different/absent value.
      const turnEffort = p.effort || (p.collaboration_mode && p.collaboration_mode.settings && p.collaboration_mode.settings.reasoning_effort) || null;
      if (model === null && p.model) model = p.model;
      if (effort === null && turnEffort) effort = turnEffort;
    }
    if (j.type === "event_msg" && p.type === "token_count" && p.info) {
      if (p.info.last_token_usage) lastTokenInfo = p.info.last_token_usage;
      if (p.info.total_token_usage) totalTokenInfo = p.info.total_token_usage;
      if (!lastTokenInfo && p.info.total_token_usage) lastTokenInfo = p.info.total_token_usage;
    }
    if (j.type === "subreviewer_meta" || j.type === "subagent_meta" || p.type === "subreviewer_meta" || p.type === "subagent_meta") {
      const source = p.info && typeof p.info === "object" ? p.info : p;
      subreviewers.push({
        name: source.name || source.role || source.id || "subreviewer",
        model: source.model || null,
        effort: source.effort || source.reasoning_effort || null,
        elapsedSec: source.elapsedSec ?? source.elapsed_sec ?? null,
        tokens: source.tokens || source.token_usage || null,
      });
    }
  }
  const elapsedSec = firstTs && lastTs ? Math.round((lastTs - firstTs) / 1000) : null;
  return { model, effort, cliVersion, provider, elapsedSec, tokens: lastTokenInfo, sessionTokens: totalTokenInfo, subreviewers };
}

const auth = getAuth();
const bestHit = findSession();
const sessionFile = bestHit && bestHit.f;
let meta = { model: null, effort: null, cliVersion: null, provider: null, elapsedSec: null, tokens: null, subreviewers: [] };
if (sessionFile) meta = parseSession(sessionFile);

const result = {
  auth,
  model: meta.model,
  effort: meta.effort,
  provider: meta.provider,
  cliVersion: meta.cliVersion,
  elapsedSec: meta.elapsedSec,
  tokens: meta.tokens,
  sessionTokens: meta.sessionTokens,
  tokenScope: meta.sessionTokens ? "codex_last_turn" : "codex_session_total",
  subreviewers: meta.subreviewers,
  subagentTokenNote: meta.subreviewers.length > 0
    ? null
    : "未记录（当前 Codex session metadata 没有提供 per-subagent 模型、思考强度、token；只能看到审查员会话总 token）",
  sessionFile: sessionFile || null,
  fourTupleBinding: {
    reviewRequestId: reqId,
    repoRoot: repoRoot || null,
    taskDir: taskDir || null,
    gitSha: expectedGitSha || null,
    sessionMatched: !!sessionFile,
    bindingStatus: bestHit?.binding?.bindingStatus || "unbound",
    matchedFields: bestHit?.binding?.matchedRequested || [],
    missingFields: bestHit?.binding?.missingRequested || [],
  },
};
console.log(JSON.stringify(result, null, 2));
