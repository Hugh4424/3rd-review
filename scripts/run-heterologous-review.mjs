#!/usr/bin/env node
// run-heterologous-review.mjs — Phase 2: cross-engine review call layer
//
// Process isolation, host exclusion, env whitelist, diff-only feed.
// Reviews run through omc ask (or direct provider binary fallback) in a
// SEPARATE process, never the host context.
//
// Exports: detectHost, selectProvider, probeAvailable, runReview
// CLI mode: --diff=<file> --round=<n> --output=<file> [--env-strip-check]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const PROVIDER_BINS = {
  codex: "codex",
  gemini: "gemini",
  antigravity: "antigravity",
  grok: "grok",
  cursor: "cursor",
};

const PROVIDER_PRIORITY = ["codex", "gemini", "antigravity", "grok", "cursor"];

const ENV_WHITELIST = new Set(["PATH", "HOME", "TERM", "LANG"]);

const PROVIDER_ENV_KEYS = {
  codex: "OPENAI_API_KEY",
  gemini: "GOOGLE_API_KEY",
  antigravity: null,
  grok: null,
  cursor: null,
};

// ═══════════════════════════════════════════════════════════════
// Trusted PATH allowlist — NEVER derive PATH from the inherited env.
// A blacklist (/tmp) cannot seal the hole: a fake binary in ANY non-/tmp
// directory prepended to PATH (e.g. $HOME/.evilbin) would still be found
// and executed by the advisor's internal bare-name lookup.
// The only root-cause fix is a static allowlist of known system bin dirs.
// ═══════════════════════════════════════════════════════════════

const TRUSTED_PATH_CANDIDATES = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  path.join(os.homedir(), ".npm-global/bin"),
  path.join(os.homedir(), ".local/bin"),
];

function buildTrustedPath() {
  const exists = TRUSTED_PATH_CANDIDATES.filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  return exists.join(path.delimiter);
}


// Diff budget: config key prompt_budget.bounded_summary_max_tokens does NOT
// exist in config/route-rules.json yet; use this module-level default so it
// works now and is override-ready when the config key is added later.
const DEFAULT_DIFF_CHAR_BUDGET = 120000;

const ROUTE_RULES_PATH = path.join(__dirname, "..", "config", "route-rules.json");

function loadRouteRules() {
  try {
    return JSON.parse(fs.readFileSync(ROUTE_RULES_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getDiffCharBudget() {
  const config = loadRouteRules();
  return config.prompt_budget?.bounded_summary_max_tokens ?? DEFAULT_DIFF_CHAR_BUDGET;
}

// ═══════════════════════════════════════════════════════════════
// detectHost
// ═══════════════════════════════════════════════════════════════

/**
 * Detect the current host environment from env markers.
 * @param {object} env - process.env or override
 * @returns {"claude-code"|"codex"|"unknown"}
 */
export function detectHost(env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_SESSION_ID) {
    return "claude-code";
  }
  if (env.CODEX_SESSION_ID || env.OPENAI_API_KEY) {
    return "codex";
  }
  return "unknown";
}

// ═══════════════════════════════════════════════════════════════
// selectProvider
// ═══════════════════════════════════════════════════════════════

/**
 * Select a provider for cross-engine review, excluding the host.
 * @param {string} host - detected host (e.g. "claude-code")
 * @param {string[]} available - list of available provider ids
 * @returns {string} provider id or "degraded-same-source"
 */
export function selectProvider(host, available) {
  for (const p of PROVIDER_PRIORITY) {
    if (p === host) continue; // exclude host
    if (available.includes(p)) return p;
  }
  return "degraded-same-source";
}

// ═══════════════════════════════════════════════════════════════
// probeAvailable
// ═══════════════════════════════════════════════════════════════

/**
 * Probe which providers are available on PATH.
 * @param {object} env - env override for probe (optional)
 * @returns {string[]} available provider ids
 */
export function probeAvailable(env = process.env) {
  // Resolve provider binaries to ABSOLUTE paths via the REAL process.env.PATH,
  // then probe with --version on the resolved absolute path.
  // Never spawn a bare binary name — that would be a PATH-shadow hijack vector.
  const probeEnv = buildProbeEnv(env);
  const available = [];
  for (const [id, binary] of Object.entries(PROVIDER_BINS)) {
    // Provider unavailability flags (for testing and integration)
    if (env.CODEX_UNAVAIL === "1" && id === "codex") continue;
    if (env.GEMINI_UNAVAIL === "1" && id === "gemini") continue;
    const absPath = resolveBinaryToAbsolutePath(binary);
    if (!absPath) continue;
    const result = spawnSync(absPath, ["--version"], {
      stdio: "ignore",
      shell: false,
      env: probeEnv,
    });
    if (result.status === 0 && !result.error) {
      available.push(id);
    }
  }
  return available;
}

/**
 * Resolve a binary name to an absolute path by scanning the REAL process.env.PATH.
 * Returns null if not found or if the resolved path is not an executable file.
 * Never returns a bare name — only absolute paths.
 * Excludes directories under /tmp and /var/tmp (production PATH-shadow vector).
 */
function resolveBinaryToAbsolutePath(binary) {
  const pathDirs = buildTrustedPath().split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, binary);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111)) {
        return candidate;
      }
    } catch {
      // Skip unreadable entries
    }
  }
  return null;
}

/**
 * Build a minimal env for probing — whitelisted vars only, sanitized PATH.
 * Isolated from potentially hijacked sourceEnv.
 */
function buildProbeEnv(sourceEnv = process.env) {
  const env = {};
  // Static trusted PATH allowlist — not the inherited (hijackable) PATH
  env.PATH = buildTrustedPath();
  for (const key of ["HOME", "TERM", "LANG"]) {
    if (key in sourceEnv) env[key] = sourceEnv[key];
  }
  return env;
}

// ═══════════════════════════════════════════════════════════════
// resolveOmcAdvisorPath
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve the path to run-provider-advisor.js via dynamic glob.
 * Returns null if omc is not found.
 */
function resolveOmcAdvisorPath() {
  try {
    const pluginDir = path.join(
      os.homedir(),
      ".claude",
      "plugins",
      "cache",
      "omc",
      "oh-my-claudecode"
    );
    if (!fs.existsSync(pluginDir)) return null;

    const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
    const versions = entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if (pa[i] !== pb[i]) return pa[i] - pb[i];
        }
        return 0;
      });

    if (versions.length === 0) return null;

    const latest = versions[versions.length - 1];
    const candidate = path.join(
      pluginDir,
      latest,
      "scripts",
      "run-provider-advisor.js"
    );
    if (fs.existsSync(candidate)) return candidate;
    return null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// buildChildEnv
// ═══════════════════════════════════════════════════════════════

/**
 * Build a whitelisted environment for the child process.
 * Whitelist: PATH, HOME, TERM, LANG + provider-specific key.
 * Strips CLAUDECODE, CLAUDE_SESSION_ID, ANTHROPIC_API_KEY, and
 * BASH_FUNC_* keys (shell-function hijack vector).
 *
 * @param {string} provider - the provider id
 * @param {object} sourceEnv - the source environment
 * @returns {object} child-safe env
 */
function buildChildEnv(provider, sourceEnv = process.env) {
  const child = {};

  for (const key of ENV_WHITELIST) {
    if (key === "PATH") {
      child[key] = buildTrustedPath();
    } else if (key in sourceEnv) {
      child[key] = sourceEnv[key];
    }
  }

  // Provider-specific key
  const keyName = PROVIDER_ENV_KEYS[provider];
  if (keyName && keyName in sourceEnv) {
    child[keyName] = sourceEnv[keyName];
  }

  // If provider is claude, preserve ANTHROPIC_API_KEY
  if (provider === "claude" && "ANTHROPIC_API_KEY" in sourceEnv) {
    child.ANTHROPIC_API_KEY = sourceEnv.ANTHROPIC_API_KEY;
  }

  return child;
}

// ═══════════════════════════════════════════════════════════════
// truncateDiff
// ═══════════════════════════════════════════════════════════════

/**
 * Truncate diff content to fit within the character budget.
 * If over budget: first 80% + "[TRUNCATED]" + last 20%.
 * @param {string} content
 * @param {number} budget
 * @returns {{ content: string, truncated: boolean }}
 */
function truncateDiff(content, budget) {
  if (content.length <= budget) {
    return { content, truncated: false };
  }

  const firstLen = Math.floor(budget * 0.8);
  const lastLen = Math.floor(budget * 0.2);
  const first = content.slice(0, firstLen);
  const last = content.slice(content.length - lastLen);

  return {
    content: first + "\n\n[TRUNCATED]\n\n" + last,
    truncated: true,
  };
}

// ═══════════════════════════════════════════════════════════════
// buildVerdictFromStdout
// ═══════════════════════════════════════════════════════════════

/**
 * Parse provider output into a verdict object.
 * Tries JSON first, falls back to text-based verdict extraction.
 */
const VALID_VERDICTS = new Set(["pass", "revise_required", "escalate_to_human"]);

/**
 * Scan mixed text for balanced top-level `{...}` JSON candidates, respecting
 * double-quoted strings and backslash escapes.  Returns an array of substring
 * spans `{start, end}` (end is exclusive index of the closing `}`).
 *
 * State-machine design (OUTSIDE / INSIDE):
 * - OUTSIDE: no object is open.  Ignore EVERY char except `{`.  A `}`, `"`,
 *   or `\` in noise text does nothing — depth can never go negative.  When we
 *   see `{`, we start a candidate: capture startIdx, set depth=1, enter INSIDE.
 * - INSIDE (depth >= 1): track strings properly so embedded braces / quotes
 *   inside string values don't corrupt bookkeeping.
 *   * Not-in-string: `"` → enter string; `{` → depth++; `}` → depth-- and if
 *     depth reaches 0 close the candidate (record span, go OUTSIDE).
 *   * In-string: only `\` (escape — skip the next char) and an unescaped `"`
 *     (exits string) matter; all other chars (including `{` `}`) are literal.
 * - A truncated trailing object (open `{` before end-of-input without a
 *   matching close) is simply not recorded — correct, incomplete = no verdict.
 *
 * This is a standard balanced-delimiter scan.  The OUTSIDE/INSIDE split
 * guarantees depth never goes negative, so stray `}` in provider log noise
 * cannot corrupt the bookkeeping.
 */
function findTopLevelJsonSpans(text) {
  const spans = [];
  let state = "OUTSIDE";
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (state === "OUTSIDE") {
      // Outside any object: ignore everything except an opening brace.
      // Stray }, ", \ are noise — do nothing.
      if (ch === "{") {
        start = i;
        depth = 1;
        inString = false;
        escape = false;
        state = "INSIDE";
      }
      continue;
    }

    // ── INSIDE ──
    if (escape) {
      // Previous char was backslash — skip this char, it's escaped.
      escape = false;
      continue;
    }

    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }

    if (inString) {
      // Inside a string: only an unescaped " (which we already handled via
      // escape check above) matters.  {, }, \ outside escape context are just
      // string content.
      if (ch === '"') inString = false;
      continue;
    }

    // Not in a string, inside an object
    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) {
        spans.push({ start, end: i + 1 });
        state = "OUTSIDE";
        start = -1;
      }
      // depth can never go below 0: we only decrement while INSIDE,
      // and INSIDE is only entered when depth is set to exactly 1.
      continue;
    }
  }

  // Trailing open object (state===INSIDE && depth>0 at end of input):
  // not recorded — incomplete, not a valid verdict.
  return spans;
}

/**
 * Walk candidate JSON spans, parse each, and return the LAST one that:
 *  - parses as valid JSON
 *  - is an object
 *  - has a string `verdict` field with one of pass|revise_required|escalate_to_human
 */
function extractVerdictJson(text, spans) {
  // Scan backwards — the provider's real answer is typically last
  for (let idx = spans.length - 1; idx >= 0; idx--) {
    const { start, end } = spans[idx];
    let candidate;
    try {
      candidate = JSON.parse(text.slice(start, end));
    } catch {
      continue;
    }
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      typeof candidate.verdict === "string" &&
      VALID_VERDICTS.has(candidate.verdict)
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Parse provider output into a verdict object.
 * Tries JSON first, falls back to text-based verdict extraction.
 *
 * B2: ONLY valid JSON with a recognized verdict enum is accepted.
 * Non-JSON / empty / garbage / missing-verdict / bogus-enum output is NEVER a pass.
 */
export function buildVerdictFromStdout(stdout, provider, diffFile, round) {
  const text = (stdout || "").trim();

  // Fast path: clean JSON output (majority of well-behaved providers)
  try {
    const parsed = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.verdict === "string" &&
      VALID_VERDICTS.has(parsed.verdict)
    ) {
      return parsed;
    }
    // Falls through — non-object, array, missing/invalid verdict → escalate
  } catch {
    // Not clean JSON — scan for JSON objects in mixed output
  }

  // Mixed-output extraction: find balanced `{...}` spans and pick the last
  // valid verdict-bearing one (providers emit the final answer last).
  const spans = findTopLevelJsonSpans(text);
  const extracted = extractVerdictJson(text, spans);
  if (extracted) return extracted;

  return {
    verdict: "escalate_to_human",
    provider,
    error: "Provider produced non-JSON output; verdict cannot be determined automatically.",
    reviewSnapshot: [{
      path: typeof diffFile === "string" ? path.basename(diffFile) : "",
      round,
      truncated: false,
      tokenUsage: { total: null },
    }],
    findings: [],
    resolutionSummary: `Provider ${provider} produced non-JSON output; escalating to human. Raw output head: ${text.slice(0, 200)}`,
    riskDisposition: [],
    worktreeInventory: { included: [], unrelated: [], excluded: [] },
  };
}

/**
 * Try to extract token usage from the provider response.
 * Uses the same mixed-output extraction logic as buildVerdictFromStdout.
 */
export function extractTokenUsage(stdout) {
  const text = (stdout || "").trim();

  // Fast path: clean JSON
  try {
    const parsed = JSON.parse(text);
    if (parsed.usage?.total_tokens) return { total: parsed.usage.total_tokens };
    if (parsed.tokenUsage?.total) return { total: parsed.tokenUsage.total };
    if (parsed.reviewSnapshot?.tokenUsage?.total) {
      return { total: parsed.reviewSnapshot.tokenUsage.total };
    }
    return { total: null };
  } catch {
    // Fall through to mixed-output extraction
  }

  // Scan for the verdict JSON in mixed output (same extraction)
  const spans = findTopLevelJsonSpans(text);
  const extracted = extractVerdictJson(text, spans);
  if (extracted) {
    if (extracted.usage?.total_tokens) return { total: extracted.usage.total_tokens };
    if (extracted.tokenUsage?.total) return { total: extracted.tokenUsage.total };
    if (extracted.reviewSnapshot?.tokenUsage?.total) {
      return { total: extracted.reviewSnapshot.tokenUsage.total };
    }
  }
  return { total: null };
}

/**
 * Resolve verifier and contract file paths for a given workflowhub stage checkpoint.
 * Returns { reviewerText, contractText } — either may be empty string if files not found.
 */
export function loadVerifierContext(checkpoint) {
  const STAGE_MAP = {
    "make-decision": ["make-decision-direction-reviewer.md", "make-decision-reviewer-contract.md"],
    "build-spec":    ["build-spec-reviewer.md",              "build-spec-reviewer-contract.md"],
    "build-plan":    ["build-plan-reviewer.md",              "build-plan-reviewer-contract.md"],
    "build-code":    ["build-code-reviewer.md",              "build-code-reviewer-contract.md"],
    "verify-code":   ["verify-code-reviewer.md",             "verify-code-reviewer-contract.md"],
  };
  const verifiersDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "verifiers", "vibecoding");
  const stage = checkpoint ? String(checkpoint).toLowerCase() : "";
  const entry = Object.entries(STAGE_MAP).find(([key]) => stage.startsWith(key));
  if (!entry) return { reviewerText: "", contractText: "" };
  const [, [reviewerFile, contractFile]] = entry;
  const readSafe = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
  return {
    reviewerText: readSafe(path.join(verifiersDir, reviewerFile)),
    contractText: readSafe(path.join(verifiersDir, contractFile)),
  };
}

/**
 * Try to build a review prompt from the diff content.
 */
function buildReviewPrompt(diffContent, provider, diffFile, round, truncated, checkpoint) {
  // truncated comes from truncateDiff() — the single source of truth (B4)
  const { reviewerText, contractText } = loadVerifierContext(checkpoint);
  const verifierSection = reviewerText
    ? `\n\n---\n## REVIEWER ROLE\n\n${reviewerText}${contractText ? `\n\n---\n## REVIEWER CONTRACT\n\n${contractText}` : ""}\n\n---\n`
    : "";
  return `${verifierSection}Review the following diff and return a JSON object with these fields:
  - "verdict": one of "pass", "revise_required", "escalate_to_human"
  - "findings": array of {severity, file, line, issue, recommendation}
  - "resolutionSummary": brief summary string
  - "reviewSnapshot": {diffFile:"${path.basename(diffFile)}", round:${round}, truncated:${truncated}}

Reply ONLY with the JSON object, no markdown fences.

DIFF:
${diffContent}`;
}

// ═══════════════════════════════════════════════════════════════
// runViaOmcAdvisor
// ═══════════════════════════════════════════════════════════════

/**
 * Run a review via the omc advisor script (absolute resolved path).
 */
function runViaOmcAdvisor(advisorPath, provider, prompt, env) {
  // Inline the prompt text directly via --prompt; the advisor reads from argv
  const result = spawnSync(
    process.execPath,
    [advisorPath, provider, "--prompt", prompt],
    {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  const stdout = (result.stdout || "").trim();
  const stderr = result.stderr || "";

  return {
    stdout,
    stderr,
    status: result.status ?? (result.error ? 1 : 0),
    error: result.error?.message ?? null,
  };
}

/**
 * The omc advisor writes its output to a .md artifact file and prints the
 * artifact path to stdout.  Extract the raw provider text from that file
 * (## Raw output section, inside ```text ... ``` fence), or return stdout
 * as-is if it does not look like an artifact path.
 */
export function resolveOmcArtifactContent(stdout) {
  const trimmed = (stdout || "").trim();
  // If stdout is valid JSON (direct provider output), return as-is
  try { JSON.parse(trimmed); return trimmed; } catch { /* not JSON — check artifact */ }

  // If stdout is a single .md file path that exists, extract Raw output from it
  const lines = trimmed.split(/\r?\n/);
  const isSinglePath = lines.length === 1 && trimmed.endsWith(".md") && !trimmed.includes("{");
  if (!isSinglePath) return trimmed;

  try {
    if (!fs.existsSync(trimmed)) return trimmed;
    const artifact = fs.readFileSync(trimmed, "utf8");
    const artifactLines = artifact.split(/\r?\n/);

    // LINE-ANCHORED: find the LAST line that is exactly "## Raw output" (after trim).
    // Earlier matches inside echoed diff text (prefixed by + or indentation) are ignored.
    let rawHeadingLineIdx = -1;
    for (let i = artifactLines.length - 1; i >= 0; i--) {
      if (artifactLines[i].trim() === "## Raw output") {
        rawHeadingLineIdx = i;
        break;
      }
    }

    if (rawHeadingLineIdx < 0) return trimmed;

    // Find the ```text fence AFTER this heading (line-anchored).
    // A ```text line must be at the start of its line (only optional whitespace).
    let fenceOpenIdx = -1;
    for (let i = rawHeadingLineIdx + 1; i < artifactLines.length; i++) {
      if (/^\s*```text\s*$/.test(artifactLines[i])) {
        fenceOpenIdx = i;
        break;
      }
    }

    if (fenceOpenIdx < 0) return trimmed;

    // Collect content lines inside the fence until a line-anchored closing ``` or ##
    const rawLines = [];
    for (let i = fenceOpenIdx + 1; i < artifactLines.length; i++) {
      const line = artifactLines[i];
      // Line-anchored closing fence or next ## header stops extraction
      if (/^\s*```\s*$/.test(line)) break;
      if (/^\s*##\s/.test(line)) break;
      rawLines.push(line);
    }

    const extracted = rawLines.join("\n").trim();
    if (!extracted) return trimmed;
    return extracted;
  } catch {
    return trimmed;
  }
}

// ═══════════════════════════════════════════════════════════════
// runThreatAuditor
// ═══════════════════════════════════════════════════════════════

/**
 * Run the deterministic threat-auditor oracle (run-threat-auditor.mjs) against
 * the review input. Returns {ran, findings, categories} for injection into the
 * verdict. ran:true ONLY when the auditor REALLY completed with parseable output.
 * Local/deterministic — no external provider calls (AC-1 timing safe).
 *
 * @param {string} diffFile - path to the diff file (may not exist in escalate paths)
 * @param {object} [opts]
 * @param {string} [opts.auditorPath] - override path to run-threat-auditor.mjs (for testing)
 * @param {string} [opts.auditorMdPath] - override path to threat-modeling-auditor.md (for testing)
 * @returns {{ran: boolean, findings: Array<{severity:string,category:string,description:string}>, categories: string[], error?: string, status?: number|null, stderr?: string, skipped?: boolean}}
 */
export function runThreatAuditor(diffFile, opts = {}) {
  const auditorMdPath = opts.auditorMdPath ?? path.resolve(
    __dirname, "..", "subreviewers", "threat-modeling-auditor.md"
  );
  const scriptPath = opts.auditorPath ?? path.resolve(__dirname, "run-threat-auditor.mjs");
  const tmpOutput = path.join(os.tmpdir(), `ta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);

  let result;
  try {
    result = spawnSync(
      process.execPath,
      [scriptPath, `--spec=${diffFile}`, `--auditor=${auditorMdPath}`, `--output=${tmpOutput}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        timeout: 15_000,
      }
    );
  } catch {
    // spawn threw (e.g. invalid args)
    try { fs.unlinkSync(tmpOutput); } catch {}
    return { ran: false, findings: [], error: "threat-auditor spawn failed", status: null, stderr: "" };
  }

  try {
    if (result.status === 0 && fs.existsSync(tmpOutput)) {
      try {
        const out = JSON.parse(fs.readFileSync(tmpOutput, "utf8"));
        if (Array.isArray(out.findings)) {
          if (out.status === "skip") {
            // AC-7: skip means the auditor did NOT actually audit anything (no
            // auditable spec). Reporting ran:true with empty findings would mask
            // a non-audit as a real audit — dishonest. Return ran:false.
            return { ran: false, findings: [], skipped: true, error: "threat-auditor skipped: no auditable spec", status: result.status };
          }
          return {
            ran: true,
            findings: out.findings,
            categories: ["forgery-bypass", "proof-independence", "schema-drift"],
          };
        }
        // findings is not an array → auditor ran but produced malformed output
        return { ran: false, findings: [], error: "threat-auditor output missing findings array", status: result.status, stderr: (result.stderr || "").slice(0, 500) };
      } catch {
        // JSON parse failed → auditor ran but produced unparseable output
        return { ran: false, findings: [], error: "threat-auditor produced unparseable output", status: result.status, stderr: (result.stderr || "").slice(0, 500) };
      }
    }
    // status !== 0 OR output file missing
    const reason = result.status !== 0
      ? `threat-auditor exited non-zero (status=${result.status})`
      : "threat-auditor produced no output file";
    return { ran: false, findings: [], error: reason, status: result.status, stderr: (result.stderr || "").slice(0, 500) };
  } finally {
    try { fs.unlinkSync(tmpOutput); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
// runReview
// ═══════════════════════════════════════════════════════════════

/**
 * Run a heterologous (cross-engine) review.
 *
 * @param {object} opts
 * @param {string} opts.diffFile - path to the diff file
 * @param {number} opts.round - review round number
 * @param {string} opts.outputFile - path to write the verdict JSON
 * @param {object} [opts.envOverride] - env override (for testing)
 * @returns {object} verdict object
 */
export function runReview({ diffFile, round, outputFile, envOverride, checkpoint }) {
  const sourceEnv = envOverride ?? process.env;
  const host = detectHost(sourceEnv);

  // ── Probe available providers using sourceEnv directly ──
  // Note: sourceEnv may be a test env with restricted PATH;
  // this is safe because probing only runs `--version`, not a review.
  if (sourceEnv.CODEX_UNAVAIL === "1") {
    // CODEX_UNAVAIL must be on sourceEnv for probeAvailable to see it
    sourceEnv.CODEX_UNAVAIL = "1";
  }
  const available = probeAvailable(sourceEnv);

  // If CODEX_UNAVAIL is set, filter codex out of available (double safety)
  let effectiveAvailable = available;
  if (sourceEnv.CODEX_UNAVAIL === "1") {
    effectiveAvailable = available.filter((p) => p !== "codex");
  }

  const selected = selectProvider(host, effectiveAvailable);

  // ── Degraded path: same-source ──
  if (selected === "degraded-same-source") {
    const verdict = {
      verdict: "escalate_to_human",
      provider: "degraded-same-source",
      degraded: "same-source",
      host,
      availableProviders: effectiveAvailable,
      reviewSnapshot: [{
        path: path.basename(diffFile),
        round,
        truncated: false,
        tokenUsage: { total: null },
      }],
      findings: [],
      resolutionSummary:
        "No heterologous provider available; review degraded to same-source. Manual review required.",
      riskDisposition: [],
      worktreeInventory: { included: [], unrelated: [], excluded: [] },
    };
    // Validate diff readability before running auditor, consistent with the
    // unreadable-diff branch. Only run the auditor when there is a readable
    // diff to audit; otherwise record ran:false with an unreadable reason.
    try {
      fs.readFileSync(diffFile, "utf8"); // validates readability
      verdict.threatAuditor = runThreatAuditor(diffFile);
    } catch {
      verdict.threatAuditor = { ran: false, findings: [], error: "threat-auditor not run: diff unreadable (degraded path)" };
    }
    fs.writeFileSync(outputFile, JSON.stringify(verdict, null, 2) + "\n");
    return verdict;
  }

  // ── Read and truncate diff ──
  let diffContent;
  try {
    diffContent = fs.readFileSync(diffFile, "utf8");
  } catch {
    const verdict = {
      verdict: "escalate_to_human",
      provider: selected,
      error: `Cannot read diffFile: ${diffFile}`,
      reviewSnapshot: [{
        path: path.basename(diffFile),
        round,
        truncated: false,
        tokenUsage: { total: null },
      }],
      findings: [],
      riskDisposition: [],
      worktreeInventory: { included: [], unrelated: [], excluded: [] },
    };
    // Diff is unreadable — the auditor has nothing to audit.
    // Spawning it on a known-unreadable file is pointless and would produce
    // misleading skip→ran results (AC-7). Record ran:false directly.
    verdict.threatAuditor = { ran: false, findings: [], error: "threat-auditor not run: diff unreadable (escalate path)" };
    fs.writeFileSync(outputFile, JSON.stringify(verdict, null, 2) + "\n");
    return verdict;
  }

  const budget = getDiffCharBudget();
  const { content: truncatedDiff, truncated } = truncateDiff(diffContent, budget);

  // ── Build prompt ──
  const prompt = buildReviewPrompt(truncatedDiff, selected, diffFile, round, truncated, checkpoint);

  // ── Build child env (whitelist) ──
  const childEnv = buildChildEnv(selected, sourceEnv);

  // ── Resolve run-provider-advisor.js path ──
  // The omc advisor is the ONLY trusted route for executing a provider binary.
  // If it cannot be resolved to a real absolute file, we escalate — never fall
  // back to a bare binary name (that is a PATH-shadow hijack vector, B1).
  const advisorPath = resolveOmcAdvisorPath();
  if (!advisorPath) {
    const verdict = {
      verdict: "escalate_to_human",
      provider: selected,
      degraded: "advisor-unavailable",
      host,
      error: "omc run-provider-advisor.js not found at ~/.claude/plugins/cache/omc/oh-my-claudecode/*/scripts/; cannot safely execute provider binary without an absolute trusted path.",
      reviewSnapshot: [{
        path: path.basename(diffFile),
        round,
        truncated,
        tokenUsage: { total: null },
      }],
      findings: [],
      resolutionSummary: "Cross-engine review unavailable: omc advisor not found, direct-binary fallback removed (PATH-hijack vector, B1). Manual review required.",
      riskDisposition: [],
      worktreeInventory: { included: [], unrelated: [], excluded: [] },
    };
    console.error(
      `[run-heterologous-review] omc advisor not found; escalating to human (direct-binary fallback removed for security — B1).`
    );
    verdict.threatAuditor = runThreatAuditor(diffFile);
    fs.writeFileSync(outputFile, JSON.stringify(verdict, null, 2) + "\n");
    return verdict;
  }

  const result = runViaOmcAdvisor(advisorPath, selected, prompt, childEnv);
  const usedAdvisor = true;

  // ── Resolve omc artifact: advisor stdout is the .md artifact path ──
  const resolvedOutput = resolveOmcArtifactContent(result.stdout);
  const { stderr, status, error } = result;

  // ── Parse output ──
  let verdict;
  try {
    verdict = buildVerdictFromStdout(resolvedOutput, selected, diffFile, round);
  } catch {
    verdict = {
      verdict: "escalate_to_human",
      provider: selected,
      error: error || `exit=${status}`,
      reviewSnapshot: [{
        path: path.basename(diffFile),
        round,
        truncated,
        tokenUsage: { total: null },
      }],
      findings: [],
      riskDisposition: [],
      worktreeInventory: { included: [], unrelated: [], excluded: [] },
    };
  }

  // ── B2: if child exited non-zero or output is empty, escalate ──
  if (status !== 0 || !resolvedOutput || resolvedOutput.length === 0) {
    verdict = {
      verdict: "escalate_to_human",
      provider: selected,
      error: error || `exit=${status}, empty=${!resolvedOutput || resolvedOutput.length === 0}`,
      reviewSnapshot: [{
        path: path.basename(diffFile),
        round,
        truncated,
        tokenUsage: { total: null },
      }],
      findings: [],
      resolutionSummary: `Provider ${selected} exited with status ${status} or produced empty output; escalating to human.`,
      riskDisposition: [],
      worktreeInventory: { included: [], unrelated: [], excluded: [] },
    };
  }

  // ── Enrich verdict ──
  verdict.provider = selected;
  verdict.host = host;

  // Normalize reviewSnapshot to array shape for standalone.sh compatibility
  const snapshotEntry = {
    path: path.basename(diffFile),
    hash: null,
    lines: diffContent.split("\n").length,
    truncated,
    tokenUsage: { total: null },
  };

  // If reviewSnapshot is an object, convert to single-element array
  if (verdict.reviewSnapshot && !Array.isArray(verdict.reviewSnapshot)) {
    verdict.reviewSnapshot = [{ ...snapshotEntry, ...verdict.reviewSnapshot }];
  } else if (!verdict.reviewSnapshot) {
    verdict.reviewSnapshot = [snapshotEntry];
  }

  // B4: force-write the REAL truncated value from truncateDiff() onto EVERY
  // reviewSnapshot entry. The provider must NEVER be able to override this.
  if (Array.isArray(verdict.reviewSnapshot)) {
    for (const entry of verdict.reviewSnapshot) {
      entry.truncated = truncated;
    }
  } else {
    verdict.reviewSnapshot.truncated = truncated;
  }

  // Token usage extraction
  const tokenUsage = extractTokenUsage(resolvedOutput);
  if (!verdict.reviewSnapshot) {
    verdict.reviewSnapshot = {
      diffFile: path.basename(diffFile),
      round,
      truncated,
      tokenUsage,
    };
  } else {
    verdict.reviewSnapshot.tokenUsage = verdict.reviewSnapshot.tokenUsage || tokenUsage;
  }

  // Ensure required pass-evidence fields exist
  if (!verdict.riskDisposition) {
    verdict.riskDisposition = [];
  }
  if (!verdict.worktreeInventory) {
    verdict.worktreeInventory = { included: [], unrelated: [], excluded: [] };
  }
  if (!Array.isArray(verdict.findings)) {
    verdict.findings = [];
  }

  verdict.trueCrossEngine = true;
  verdict.reviewMode = "omc-ask";

  // AC-7 / FR-QUALITY-001 dim 4: run threat-auditor in ALL review modes
  verdict.threatAuditor = runThreatAuditor(diffFile);

  // Write
  fs.writeFileSync(outputFile, JSON.stringify(verdict, null, 2) + "\n");

  return verdict;
}

// ═══════════════════════════════════════════════════════════════
// CLI mode
// ═══════════════════════════════════════════════════════════════

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const prefix = `--${name}=`;
    const found = args.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };

  // --env-strip-check: dump child env to stdout for the test to assert
  if (args.includes("--env-strip-check")) {
    const sourceEnv = { ...process.env };
    // Build child env for 'codex' provider
    const childEnv = buildChildEnv("codex", sourceEnv);
    console.log(JSON.stringify(childEnv));
    process.exit(0);
  }

  const diffFile = getArg("diff");
  const outputFile = getArg("output");
  const round = parseInt(getArg("round") || "1", 10);
  const checkpoint = getArg("checkpoint");

  if (!diffFile || !outputFile) {
    console.error("Usage: run-heterologous-review.mjs --diff=<file> --round=<n> --output=<file> [--checkpoint=<stage>] [--env-strip-check]");
    process.exit(1);
  }

  try {
    runReview({ diffFile, round, outputFile, checkpoint });
    process.exit(0);
  } catch (e) {
    console.error(`[run-heterologous-review] Fatal error: ${e.message}`);
    process.exit(1);
  }
}
