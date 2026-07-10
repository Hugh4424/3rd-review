#!/usr/bin/env node
// run-heterologous-review.mjs — Phase 2: cross-engine review call layer
//
// Process isolation, host exclusion, env whitelist, diff-only feed.
// Reviews run through omc ask (or direct provider binary fallback) in a
// SEPARATE process, never the host context.
//
// Exports: detectHost, selectProvider, probeAvailable, runReview
// CLI mode: --diff=<file> --output=<file> [--env-strip-check]
// --diff file must contain JSON {mode, contract, materials} (FR-THIRDREVIEW-001).
// Zero stage/round knowledge: legacy --stage/--round/--checkpoint flags are
// rejected with a non-zero exit and an explicit error, never silently ignored.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const PROVIDER_BINS = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  antigravity: "antigravity",
  grok: "grok",
  cursor: "cursor",
};

const PROVIDER_PRIORITY = ["claude-code", "codex", "gemini", "antigravity", "grok", "cursor"];

export const REVIEW_TIMEOUT_MS = 600_000;

const ENV_WHITELIST = new Set(["PATH", "HOME", "TERM", "LANG"]);

const PROVIDER_ENV_KEYS = {
  "claude-code": "ANTHROPIC_API_KEY",
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
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

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

const HOST_PROVIDER_ALIASES = new Map([
  ["claude", "claude-code"], ["claude-code", "claude-code"],
  ["codex", "codex"], ["openai-codex", "codex"],
  ["gemini", "gemini"], ["antigravity", "antigravity"],
  ["grok", "grok"], ["cursor", "cursor"],
]);

/** Normalize only registered host-provider enum values; arbitrary strings fail closed. */
export function normalizeHostProvider(value) {
  if (typeof value !== "string") return "unknown";
  return HOST_PROVIDER_ALIASES.get(value.trim().toLowerCase()) ?? "unknown";
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
    if (env.CLAUDE_UNAVAIL === "1" && id === "claude-code") continue;
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

function readSafeArtifact(filePath, expectedSha256) {
  const absolute = path.resolve(filePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact is not a regular non-symlink file: ${absolute}`);
  if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${absolute}`);
  const content = fs.readFileSync(absolute, "utf8");
  const sha256 = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  if (expectedSha256 && sha256 !== String(expectedSha256).toLowerCase()) {
    throw new Error(`Artifact hash mismatch: ${absolute}`);
  }
  return { path: absolute, content, bytes: Buffer.byteLength(content), sha256 };
}

function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

function artifactLineCount(bytes) {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 10) lines++;
  return lines + (bytes.at(-1) === 10 ? 0 : 1);
}

function resolveWhArtifactManifest(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || !Array.isArray(descriptor.entries) || !/^[a-f0-9]{64}$/.test(descriptor.content_hash || "")) {
    throw new Error("WH artifact_manifest descriptor is invalid");
  }
  const packageRootInput = path.resolve(String(descriptor.package_root || ""));
  const rootStat = fs.lstatSync(packageRootInput);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("WH package_root is not a regular directory");
  const packageRoot = fs.realpathSync(packageRootInput);
  const manifestPath = path.resolve(String(descriptor.manifest_path || ""));
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("WH manifest is not a regular non-symlink file");
  const manifestReal = fs.realpathSync(manifestPath);
  if (!insideRoot(packageRoot, manifestReal)) throw new Error("WH manifest escapes package_root");
  const manifestArtifact = readSafeArtifact(manifestReal);
  const manifest = JSON.parse(manifestArtifact.content);
  if (manifest.version !== 6 || manifest.chunk_max_bytes !== 65536 || manifest.chunk_max_line_codepoints !== 1000 || !Array.isArray(manifest.entries)) {
    throw new Error("WH manifest shape is invalid");
  }
  const canonicalHash = createHash("sha256").update(Buffer.from(`${JSON.stringify(manifest.entries, null, 2)}\n`)).digest("hex");
  if (canonicalHash !== manifest.content_hash || canonicalHash !== descriptor.content_hash || JSON.stringify(manifest.entries) !== JSON.stringify(descriptor.entries)) {
    throw new Error("WH manifest descriptor/content hash mismatch");
  }
  const coverage = [];
  const sections = [];
  let totalBytes = 0;
  const seenIds = new Set();
  for (const item of manifest.entries) {
    if (!item || typeof item.id !== "string" || seenIds.has(item.id) || !Array.isArray(item.chunks) || item.chunks.length === 0) throw new Error("WH manifest entry invalid");
    seenIds.add(item.id);
    if (typeof item.path !== "string" || path.isAbsolute(item.path) || item.path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw new Error("WH logical entry path invalid");
    const logicalPath = path.resolve(packageRoot, item.path);
    const logicalStat = fs.lstatSync(logicalPath);
    if (!logicalStat.isFile() || logicalStat.isSymbolicLink()) throw new Error("WH logical entry is not a regular non-symlink file");
    const logicalReal = fs.realpathSync(logicalPath);
    if (!insideRoot(packageRoot, logicalReal)) throw new Error("WH logical entry escapes package_root");
    const logicalArtifact = readSafeArtifact(logicalReal, item.sha256);
    if (logicalArtifact.bytes !== item.bytes) throw new Error("WH logical entry byte count mismatch");
    const chunkBuffers = [];
    const chunkCoverage = [];
    for (const [index, chunk] of item.chunks.entries()) {
      if (chunk.sequence !== index + 1 || typeof chunk.path !== "string" || path.isAbsolute(chunk.path) || chunk.path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw new Error("WH chunk path/sequence invalid");
      const chunkPath = path.resolve(packageRoot, chunk.path);
      const chunkStat = fs.lstatSync(chunkPath);
      if (!chunkStat.isFile() || chunkStat.isSymbolicLink()) throw new Error("WH chunk is not a regular non-symlink file");
      const chunkReal = fs.realpathSync(chunkPath);
      if (!insideRoot(packageRoot, chunkReal)) throw new Error("WH chunk escapes package_root");
      const artifact = readSafeArtifact(chunkReal, chunk.sha256);
      const chunkBuffer = Buffer.from(artifact.content, "utf8");
      if (artifact.bytes !== chunk.bytes || artifact.bytes > 65536 || artifactLineCount(chunkBuffer) !== chunk.lines || artifact.content.split("\n").some((line) => [...line].length > 1000)) throw new Error("WH chunk byte/line contract mismatch");
      chunkBuffers.push(chunkBuffer);
      chunkCoverage.push({ sequence: chunk.sequence, path: chunk.path, bytes: artifact.bytes, lines: chunk.lines, sha256: artifact.sha256, included: true });
    }
    const logical = Buffer.concat(chunkBuffers);
    const logicalHash = createHash("sha256").update(logical).digest("hex");
    if (logical.length !== item.bytes || logicalHash !== item.sha256 || artifactLineCount(logical) !== item.lines) throw new Error("WH chunks do not reconstruct logical entry");
    totalBytes += logical.length;
    if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`Artifact package exceeds ${MAX_PACKAGE_BYTES} bytes`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(logical);
    sections.push(`\n\n--- ARTIFACT: ${item.id} | ${item.role} | ${item.kind} ---\n${text}`);
    coverage.push({ id: item.id, role: item.role, kind: item.kind, path: item.path, bytes: item.bytes, sha256: item.sha256, status: "read", included: true, chunks: chunkCoverage });
  }
  if (!seenIds.has("contract") || !manifest.entries.some((item) => item.role === "materials")) throw new Error("WH manifest lacks contract/materials");
  const contract = sections[manifest.entries.findIndex((item) => item.id === "contract")];
  return { contract, materials: sections.join(""), coverage, package: { root: packageRoot, manifestPath: manifestReal, artifactCount: coverage.length, totalBytes, contentHash: canonicalHash } };
}

/** Resolve embedded/referenced payload and manifest into one deterministic package. */
export function resolveArtifactPackage(diffFile) {
  const root = readSafeArtifact(diffFile);
  const baseDir = path.dirname(root.path);
  let envelope = JSON.parse(root.content);
  if (envelope.artifact_manifest) {
    const wh = resolveWhArtifactManifest(envelope.artifact_manifest);
    return { mode: envelope.mode, contract: wh.contract, materials: wh.materials, canonicalArtifact: true,
      requestedProvider: envelope.provider, coverage: wh.coverage,
      package: { ...wh.package, materialsSha256: createHash("sha256").update(Buffer.from(wh.materials)).digest("hex"), inlineMaterialsBytes: 0 } };
  }
  const payloadRef = envelope.payloadPath ?? (typeof envelope.payload === "string" ? envelope.payload : null);
  if (payloadRef) envelope = JSON.parse(readSafeArtifact(path.resolve(baseDir, payloadRef)).content);
  else if (envelope.payload && typeof envelope.payload === "object") envelope = envelope.payload;

  let manifest = envelope.manifest;
  if (envelope.manifestPath) manifest = JSON.parse(readSafeArtifact(path.resolve(baseDir, envelope.manifestPath)).content);
  const entries = Array.isArray(manifest) ? manifest
    : (manifest?.files ?? manifest?.artifacts ?? manifest?.entries ?? []);
  if (!Array.isArray(entries)) throw new Error("Manifest entries must be an array");

  const coverage = [];
  const sections = [];
  let totalBytes = Buffer.byteLength(String(envelope.materials ?? ""));
  for (const rawEntry of entries) {
    const entry = typeof rawEntry === "string" ? { path: rawEntry } : rawEntry;
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
      throw new Error("Every manifest entry requires a path");
    }
    let artifact;
    if (typeof entry.content === "string") {
      const sha256 = createHash("sha256").update(Buffer.from(entry.content)).digest("hex");
      if (entry.sha256 && sha256 !== String(entry.sha256).toLowerCase()) throw new Error(`Embedded artifact hash mismatch: ${entry.path}`);
      artifact = { path: entry.path, content: entry.content, bytes: Buffer.byteLength(entry.content), sha256 };
    } else {
      artifact = readSafeArtifact(path.isAbsolute(entry.path) ? entry.path : path.resolve(baseDir, entry.path), entry.sha256);
    }
    totalBytes += artifact.bytes;
    if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`Artifact package exceeds ${MAX_PACKAGE_BYTES} bytes`);
    coverage.push({ path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256, included: true });
    sections.push(`\n\n--- ARTIFACT: ${artifact.path} ---\n${artifact.content}`);
  }
  const combinedMaterials = String(envelope.materials ?? "") + sections.join("");
  return {
    mode: envelope.mode, contract: envelope.contract,
    materials: combinedMaterials,
    requestedProvider: envelope.provider,
    coverage,
    package: {
      root: root.path, artifactCount: coverage.length, totalBytes,
      materialsSha256: createHash("sha256").update(Buffer.from(combinedMaterials)).digest("hex"),
      inlineMaterialsBytes: Buffer.byteLength(String(envelope.materials ?? "")),
    },
  };
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

export function resolveBinaryCandidates(binary, { binRoots = TRUSTED_PATH_CANDIDATES, pathValue = process.env.PATH } = {}) {
  const dirs = [...binRoots];
  // Include current PATH ordering, but only retain candidates whose real path
  // is inside a statically trusted directory. A PATH-shadow outside the trust
  // roots is observed and ignored, never executed.
  for (const dir of String(pathValue || "").split(path.delimiter)) if (dir) dirs.push(dir);
  const trustedRoots = binRoots.map((dir) => path.resolve(dir));
  const results = [];
  const seen = new Set();
  for (const dir of dirs) {
    const candidate = path.resolve(dir, binary);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const real = fs.realpathSync(candidate);
      const targetStat = fs.statSync(real);
      if (!targetStat.isFile() || !(targetStat.mode & 0o111)) continue;
      const owningBinRoot = trustedRoots.find((root) => insideRoot(root, candidate));
      if (!owningBinRoot) continue;
      if (stat.isSymbolicLink()) {
        const packageRoot = fs.realpathSync(path.resolve(path.dirname(owningBinRoot), "lib", "node_modules"));
        if (!insideRoot(packageRoot, real)) continue;
      } else if (!insideRoot(owningBinRoot, real)) continue;
      if (!seen.has(real)) { seen.add(real); results.push(real); }
    } catch {}
  }
  return results;
}

const REQUIRED_CLAUDE_FLAGS = ["--print", "--output-format", "--json-schema", "--safe-mode", "--tools", "--permission-mode", "--no-session-persistence"];

export function selectCompatibleClaudeCode({ env = process.env, candidates } = {}) {
  const paths = candidates ?? resolveBinaryCandidates("claude");
  const attempts = [];
  for (const binaryPath of paths) {
    const versionResult = spawnSync(binaryPath, ["--version"], { env, encoding: "utf8", shell: false, timeout: 10_000 });
    const helpResult = spawnSync(binaryPath, ["--help"], { env, encoding: "utf8", shell: false, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    const version = String(versionResult.stdout || "").trim().split(/\r?\n/, 1)[0].slice(0, 120);
    const help = String(helpResult.stdout || "");
    const missingFlags = REQUIRED_CLAUDE_FLAGS.filter((flag) => !new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|,|$)`, "m").test(help));
    let rejectionReason = null;
    if (versionResult.status !== 0) rejectionReason = "version-preflight-failed";
    else if (helpResult.status !== 0) rejectionReason = "help-preflight-failed";
    else if (missingFlags.length) rejectionReason = `missing-required-flags:${missingFlags.join(",")}`;
    attempts.push({ binaryPath, version: version || null, compatible: rejectionReason === null, rejectionReason });
    if (!rejectionReason) return { binaryPath, version, attempts };
  }
  return { binaryPath: null, version: null, attempts };
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

  // Claude Code may use an API key; subscription auth remains available via HOME.
  if (provider === "claude-code" && "ANTHROPIC_API_KEY" in sourceEnv) {
    child.ANTHROPIC_API_KEY = sourceEnv.ANTHROPIC_API_KEY;
  }

  return child;
}

const REVIEW_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { enum: ["pass", "revise_required", "escalate_to_human"] },
    findings: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { severity: { enum: ["blocking", "important", "minor"] }, file: { type: "string" },
        line: { type: "integer", minimum: 0 }, issue: { type: "string" }, recommendation: { type: "string" } },
      required: ["severity", "file", "line", "issue", "recommendation"] } },
    resolutionSummary: { type: "string" },
  },
  required: ["verdict", "findings", "resolutionSummary"],
});

function validateStructuredVerdict(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: [{ code: "type", path: "/" }] };
  const allowed = new Set(["verdict", "findings", "resolutionSummary"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push({ code: "additional_property", path: `/${key}` });
  if (!VALID_VERDICTS.has(value.verdict)) errors.push({ code: "enum", path: "/verdict" });
  if (typeof value.resolutionSummary !== "string") errors.push({ code: "type", path: "/resolutionSummary" });
  if (!Array.isArray(value.findings)) errors.push({ code: "type", path: "/findings" });
  else value.findings.forEach((finding, index) => {
    const base = `/findings/${index}`;
    const keys = new Set(["severity", "file", "line", "issue", "recommendation"]);
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) { errors.push({ code: "type", path: base }); return; }
    for (const key of Object.keys(finding)) if (!keys.has(key)) errors.push({ code: "additional_property", path: `${base}/${key}` });
    if (!new Set(["blocking", "important", "minor"]).has(finding.severity)) errors.push({ code: "enum", path: `${base}/severity` });
    for (const key of ["file", "issue", "recommendation"]) if (typeof finding[key] !== "string") errors.push({ code: "type", path: `${base}/${key}` });
    if (!Number.isInteger(finding.line) || finding.line < 0) errors.push({ code: "type", path: `${base}/line` });
  });
  return { valid: errors.length === 0, errors };
}

/** Parse the documented Claude Code --output-format=json envelope exactly. */
export function parseClaudeCodeResult(stdout) {
  const envelope = JSON.parse((stdout || "").trim());
  if (envelope && typeof envelope.structured_output === "object" && envelope.structured_output !== null) {
    const validation = validateStructuredVerdict(envelope.structured_output);
    if (!validation.valid) throw new Error("Claude Code structured_output failed schema validation");
    return envelope.structured_output;
  }
  if (typeof envelope?.result === "string") {
    const parsed = JSON.parse(envelope.result.trim());
    const validation = validateStructuredVerdict(parsed);
    if (!validation.valid) throw new Error("Claude Code result failed schema validation");
    return parsed;
  }
  throw new Error("Claude Code JSON envelope contained neither structured_output nor JSON result");
}

export function describeClaudeOutputShape(stdout) {
  let envelope;
  try { envelope = JSON.parse(String(stdout || "").trim()); }
  catch { return { envelope_json_parseable: false }; }
  const structured = envelope?.structured_output;
  const resultPresent = typeof envelope?.result === "string";
  let resultParsed = null;
  if (resultPresent) { try { resultParsed = JSON.parse(envelope.result); } catch {} }
  const candidate = structured && typeof structured === "object" ? structured : resultParsed;
  const validation = validateStructuredVerdict(candidate);
  return {
    envelope_json_parseable: true,
    structured_output: { type: structured === null ? "null" : Array.isArray(structured) ? "array" : typeof structured, is_null: structured === null },
    result: { present: resultPresent, bytes: resultPresent ? Buffer.byteLength(envelope.result) : 0, json_parseable: resultParsed !== null },
    parsed: { top_level_keys: candidate && typeof candidate === "object" && !Array.isArray(candidate) ? Object.keys(candidate).filter((k) => ["verdict", "findings", "resolutionSummary"].includes(k)).sort() : [],
      shape: candidate === null ? "null" : Array.isArray(candidate) ? "array" : typeof candidate,
      verdict_enum_valid: Boolean(candidate && VALID_VERDICTS.has(candidate.verdict)) },
    schema_errors: validation.errors.slice(0, 50),
  };
}

function runViaClaudeCode(binaryPath, prompt, env, timeoutMs = REVIEW_TIMEOUT_MS, artifactPackage = null) {
  const scopedPackage = artifactPackage ? `//${artifactPackage.root.replace(/^\/+/, "")}/**` : null;
  const args = artifactPackage ? [
    "--print", "--verbose", "--output-format", "stream-json", "--json-schema", REVIEW_JSON_SCHEMA,
    "--safe-mode", "--tools", "Read", "--allowedTools", `Read(${scopedPackage})`, "--permission-mode", "dontAsk",
    "--no-session-persistence",
  ] : [
    "--print", "--output-format", "json", "--json-schema", REVIEW_JSON_SCHEMA,
    "--safe-mode", "--tools", "", "--permission-mode", "dontAsk", "--no-session-persistence",
  ];
  const startedAt = new Date().toISOString();
  const result = spawnSync(binaryPath, args, {
    env, cwd: artifactPackage?.root, encoding: "utf8", input: prompt, stdio: ["pipe", "pipe", "pipe"], shell: false,
    timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout || "", stderr: result.stderr || "",
    status: result.status ?? (result.error ? 1 : 0), error: result.error?.message ?? null,
    errorCode: result.error?.code ?? null, signal: result.signal ?? null,
    provenance: { adapter: "claude-code-cli", binaryPath, args, transport: "stdin", startedAt,
      finishedAt: new Date().toISOString(), timeoutMs },
  };
}

export function attestScopedReadStream(stdout, coverage, packageRoot) {
  const expected = new Map();
  let violation = null;
  for (const item of coverage) for (const chunk of item.chunks || []) {
    const absolute = fs.realpathSync(path.resolve(packageRoot, chunk.path));
    const bytes = fs.readFileSync(absolute);
    if (bytes.length !== chunk.bytes || artifactLineCount(bytes) !== chunk.lines || createHash("sha256").update(bytes).digest("hex") !== chunk.sha256) violation = "declared-chunk-hash-mismatch";
    expected.set(absolute, { item, chunk });
  }
  const pending = new Map(), completed = new Set();
  let finalEvent = null;
  const toolResultShapes = [];
  for (const line of String(stdout || "").split(/\r?\n/).filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const normalized = event?.type === "stream_event" && event.event ? event.event : event;
    if (normalized?.type === "assistant") for (const block of normalized.message?.content || []) if (block?.type === "tool_use") {
      if (block.name !== "Read") { violation = "non-read-tool"; continue; }
      let real; try { real = fs.realpathSync(block.input?.file_path); } catch { violation = "unreadable-read-path"; continue; }
      const declared = expected.get(real);
      if (!declared) { violation = "read-path-outside-package"; continue; }
      if (Number(block.input?.offset ?? 1) !== 1 || Number(block.input?.limit ?? Infinity) < declared.chunk.lines) { violation = "partial-chunk-read"; continue; }
      pending.set(block.id, { real, declared });
    }
    if (normalized?.type === "user") for (const block of normalized.message?.content || []) if (block?.type === "tool_result") {
      const observed = pending.get(block.tool_use_id);
      if (!observed || block.is_error) continue;
      const content = typeof block.content === "string" ? block.content
        : Array.isArray(block.content) && block.content.every((part) => part?.type === "text") ? block.content.map((part) => part.text).join("") : null;
      const contentBytes = Buffer.from(content || "", "utf8");
      const firstLine = String(content || "").split("\n", 1)[0];
      const prefix = /^\s*\d+\t/u.test(firstLine) ? "tab-line-number" : /^\s*\d+→/u.test(firstLine) ? "arrow-line-number" : content === "" ? "empty" : "unknown";
      toolResultShapes.push({ content_type: Array.isArray(block.content) ? "blocks" : typeof block.content,
        block_types: Array.isArray(block.content) ? block.content.map((part) => String(part?.type || "unknown")).slice(0, 20) : [],
        line_count: content === "" ? 0 : String(content || "").split("\n").length, prefix,
        bytes: contentBytes.length, sha256: createHash("sha256").update(contentBytes).digest("hex") });
      const source = fs.readFileSync(observed.real, "utf8");
      const sourceLines = source === "" ? [] : source.replace(/\n$/u, "").split("\n").map((line) => line.replace(/\r$/u, ""));
      const outputLines = content === "" ? [] : String(content ?? "").split("\n");
      const exact = sourceLines.length === 0 ? content === "" : outputLines.length === sourceLines.length && outputLines.every((line, index) => {
        const match = line.match(/^\s*(\d+)(?:\t|→)(.*)$/u);
        return match && Number(match[1]) === index + 1 && match[2] === sourceLines[index];
      });
      if (exact) completed.add(observed.real); else violation = "read-result-content-mismatch";
    }
    if (event?.type === "result") finalEvent = event;
  }
  const missing = [...expected.keys()].filter((item) => !completed.has(item));
  return { valid: Boolean(finalEvent) && !violation && missing.length === 0, finalEvent, violation, missing, toolResultShapes,
    artifactCoverage: coverage.map((item) => ({ id: item.id, sha256: item.sha256,
      status: (item.chunks || []).every((chunk) => completed.has(fs.realpathSync(path.resolve(packageRoot, chunk.path)))) ? "read" : "failed" })) };
}

const RETRYABLE_CLAUDE_API_STATUSES = new Set([408, 429, 502, 503, 504, 524, 529]);
const RETRY_TOTAL_BUDGET_MS = REVIEW_TIMEOUT_MS - 1_000; // reserve process teardown/serialization margin
const blockingSleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// One initial isolated attempt plus at most one fresh retry. More retries can
// accidentally turn a deterministic contract failure into an expensive loop.
export function runClaudeCodeWithRetry({ execute, maxAttempts = 2, totalBudgetMs = RETRY_TOTAL_BUDGET_MS, now = Date.now, sleep = blockingSleep } = {}) {
  const started = now();
  const attempts = [];
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsedBefore = Math.max(0, now() - started);
    const remaining = Math.max(0, totalBudgetMs - elapsedBefore);
    if (remaining <= 0) break;
    result = execute({ attempt, timeoutMs: remaining });
    const envelope = extractSafeClaudeEnvelopeMetadata(result.stdout);
    const apiStatus = envelope?.api_error_status ?? null;
    const retryable = result.status !== 0 && RETRYABLE_CLAUDE_API_STATUSES.has(apiStatus);
    attempts.push({ attempt, status: result.status, signal: result.signal ?? null, errorCode: result.errorCode ?? null,
      api_error_status: apiStatus, subtype: envelope?.subtype ?? null, terminal_reason: envelope?.terminal_reason ?? null,
      retryable, elapsedMs: Math.max(0, now() - started) });
    if (!retryable || attempt >= maxAttempts) break;
    const delayMs = Math.min(10_000, 1_000 * (2 ** (attempt - 1)));
    if (now() - started + delayMs >= totalBudgetMs) break;
    sleep(delayMs);
  }
  if (!result) result = { stdout: "", stderr: "", status: 1, error: "Claude retry budget exhausted before first attempt", errorCode: "ETIMEDOUT", signal: null, provenance: {} };
  result.provenance ||= {};
  result.provenance.attemptSummaries = attempts;
  result.provenance.maxAttempts = maxAttempts;
  result.provenance.totalBudgetMs = totalBudgetMs;
  result.provenance.totalElapsedMs = Math.max(0, now() - started);
  return result;
}

function streamMetadata(value) {
  const bytes = Buffer.from(value || "", "utf8");
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function redactSafeText(value, limit = 240) {
  return String(value ?? "")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{6,}\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, limit);
}

/** Extract non-content diagnostics from a Claude JSON envelope. */
export function extractSafeClaudeEnvelopeMetadata(stdout) {
  let envelope;
  const text = String(stdout || "").trim();
  try { envelope = JSON.parse(text); }
  catch {
    for (const line of text.split(/\r?\n/).reverse()) {
      try { const event = JSON.parse(line); if (event?.type === "result") { envelope = event; break; } } catch {}
    }
    if (!envelope) return null;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const out = {};
  for (const key of ["type", "subtype", "terminal_reason", "stop_reason"]) {
    if (typeof envelope[key] === "string") out[key] = redactSafeText(envelope[key], 120);
  }
  if (typeof envelope.is_error === "boolean") out.is_error = envelope.is_error;
  if (Number.isFinite(envelope.api_error_status)) out.api_error_status = Number(envelope.api_error_status);
  if (Number.isFinite(envelope.duration_api_ms)) out.duration_api_ms = Number(envelope.duration_api_ms);
  if (Number.isInteger(envelope.num_turns)) out.num_turns = envelope.num_turns;
  const denials = Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [];
  out.permission_denials = {
    count: denials.length,
    items: denials.slice(0, 20).map((item) => ({
      code: redactSafeText(item?.code ?? item?.type ?? "unknown", 80),
      message: redactSafeText(item?.message ?? item?.reason ?? "", 200),
    })),
  };
  const errors = Array.isArray(envelope.errors) ? envelope.errors : (envelope.error && typeof envelope.error === "object" ? [envelope.error] : []);
  out.errors = errors.slice(0, 20).map((item) => ({
    code: redactSafeText(item?.code ?? item?.type ?? "unknown", 80),
    message: redactSafeText(item?.message ?? "", 200),
  }));
  return out;
}

export function claudeFailureReason(result, envelopeMetadata) {
  if (result.errorCode === "EREADATTEST") return result.provenance?.scopedRead?.violation === "read-result-content-mismatch"
    ? "read-result-content-mismatch" : "artifact-coverage-unattested";
  if (result.status === 0) return "claude-code-output-invalid";
  if (envelopeMetadata?.api_error_status) return `claude-code-api-error-${envelopeMetadata.api_error_status}`;
  if (envelopeMetadata?.terminal_reason) return `claude-code-${String(envelopeMetadata.terminal_reason).replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`;
  if (envelopeMetadata?.subtype) return `claude-code-${String(envelopeMetadata.subtype).replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`;
  return "claude-code-process-failed";
}

function writeDiagnostic(outputFile, diagnostic) {
  const diagnosticPath = `${outputFile}.diagnostic.json`;
  fs.writeFileSync(diagnosticPath, JSON.stringify(diagnostic, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(diagnosticPath, 0o600);
  return diagnosticPath;
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
export function buildVerdictFromStdout(stdout, provider, diffFile) {
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
 * Build a review prompt from the structured {mode, contract, materials} payload.
 * The engine has zero stage/round knowledge — mode and contract are the only
 * routing-relevant fields it receives, both explicit and never collapsed into
 * the materials text (FR-THIRDREVIEW-001, decision-log D1).
 */
function buildReviewPrompt({ mode, contract, materialsContent, diffFile, truncated, artifactPackage, coverage = [] }) {
  if (artifactPackage) return `Review mode: ${mode}\nUse only Read. Read every declared chunk in full and in sequence. Do not read outside package root.\nPackage root: ${artifactPackage.root}\nManifest: ${artifactPackage.manifestPath}\nChunks:\n${coverage.flatMap((item) => (item.chunks || []).map((chunk) => `${item.id}|${chunk.sequence}|${chunk.path}|${chunk.bytes}|${chunk.sha256}`)).join("\n")}\nReturn only schema-valid JSON after all chunks are read.`;
  const contractSection = contract
    ? `\n\n---\n## REVIEW CONTRACT\n\n${contract}\n\n---\n`
    : "";
  return `${contractSection}Review mode: ${mode}

Review the following materials and return a JSON object with these fields:
  - "verdict": one of "pass", "revise_required", "escalate_to_human"
  - "findings": array of {severity, file, line, issue, recommendation}
  - "resolutionSummary": brief summary string

Reply ONLY with the JSON object, no markdown fences.

MATERIALS:
${materialsContent}`;
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
 * @param {string} opts.diffFile - path to a file containing JSON {mode, contract, materials}
 * @param {string} opts.outputFile - path to write the verdict JSON
 * @param {object} [opts.envOverride] - env override (for testing)
 * @returns {object} verdict object
 */
export function runReview({ diffFile, outputFile, envOverride, hostProvider, provider, claudeBinaryPath, claudeBinaryCandidates }) {
  const sourceEnv = envOverride ?? process.env;
  const explicitHost = hostProvider ?? sourceEnv.REVIEW_HOST_PROVIDER;
  const host = explicitHost === undefined
    ? normalizeHostProvider(detectHost(sourceEnv))
    : normalizeHostProvider(explicitHost);

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

  // Unknown host can never prove heterology. Fail closed even if providers exist.
  const requestedProviderRaw = provider ?? sourceEnv.REVIEW_PROVIDER;

  // ── Read and parse the structured {mode, contract, materials} payload ──
  // The engine has zero stage/round knowledge: --diff carries the fully
  // assembled review input as JSON, never a raw unstructured diff (FR-THIRDREVIEW-001).
  let payload;
  try {
    payload = resolveArtifactPackage(diffFile);
  } catch (e) {
    const verdict = {
      verdict: "escalate_to_human",
      provider: requestedProviderRaw ? normalizeHostProvider(requestedProviderRaw) : "not-selected",
      actual_mode: "not_executed",
      error: `Cannot read/parse diffFile as {mode,contract,materials} JSON: ${diffFile} (${e.message})`,
      reviewSnapshot: [{
        path: path.basename(diffFile),
        truncated: false,
        tokenUsage: { total: null },
      }],
      findings: [],
      riskDisposition: [],
      worktreeInventory: { included: [], unrelated: [], excluded: [] },
    };
    verdict.threatAuditor = { ran: false, findings: [], error: "threat-auditor not run: diff payload unreadable/unparsable" };
    fs.writeFileSync(outputFile, JSON.stringify(verdict, null, 2) + "\n");
    return verdict;
  }

  const { mode, contract, materials } = payload || {};
  const payloadProvider = payload?.requestedProvider;
  const explicitProviderRaw = requestedProviderRaw ?? payloadProvider;
  const explicitProvider = explicitProviderRaw === undefined ? null : normalizeHostProvider(explicitProviderRaw);
  const selected = explicitProviderRaw !== undefined
    ? (explicitProvider === "unknown" ? "degraded-same-source" : explicitProvider)
    : (host === "unknown" ? "degraded-same-source" : selectProvider(host, effectiveAvailable));
  if (typeof mode !== "string" || typeof contract !== "string" || typeof materials !== "string") {
    const verdict = {
      verdict: "escalate_to_human",
      provider: selected,
      actual_mode: "not_executed",
      error: `Malformed diff payload: expected {mode, contract, materials} all strings, got keys ${JSON.stringify(Object.keys(payload || {}))}`,
      reviewSnapshot: [{
        path: path.basename(diffFile),
        truncated: false,
        tokenUsage: { total: null },
      }],
      findings: [],
      riskDisposition: [],
      worktreeInventory: { included: [], unrelated: [], excluded: [] },
    };
    verdict.threatAuditor = { ran: false, findings: [], error: "threat-auditor not run: diff payload malformed" };
    fs.writeFileSync(outputFile, JSON.stringify(verdict, null, 2) + "\n");
    return verdict;
  }

  if (explicitProviderRaw !== undefined && (explicitProvider === "unknown" || explicitProvider === host || !effectiveAvailable.includes(explicitProvider)) && !claudeBinaryPath && !claudeBinaryCandidates) {
    const verdict = { verdict: "escalate_to_human", provider: explicitProvider === "unknown" ? "not-selected" : explicitProvider,
      host, actual_mode: "not_executed", findings: [], reviewSnapshot: [], riskDisposition: [],
      worktreeInventory: { included: [], unrelated: [], excluded: [] },
      error: explicitProvider === host ? "Explicit provider is same-source" : "Explicit provider is invalid or unavailable; no provider switch was attempted.",
      synthetic: true, execution_status: "failed", trueCrossEngine: false,
      failure_reason: explicitProvider === host ? "same-source-provider" : "explicit-provider-unavailable",
      provenance: { requestedProvider: explicitProviderRaw, providerSwitchAttempted: false } };
    fs.writeFileSync(outputFile, JSON.stringify(verdict, null, 2) + "\n");
    return verdict;
  }

  // materials is the auditable text; diffFile itself now holds the JSON
  // envelope, so the threat-auditor is fed a materials-only temp file.
  const materialsAuditPath = path.join(
    os.tmpdir(),
    `rhr-materials-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  const runMaterialsAudit = () => {
    try {
      fs.writeFileSync(materialsAuditPath, materials);
      return runThreatAuditor(materialsAuditPath);
    } finally {
      try { fs.unlinkSync(materialsAuditPath); } catch {}
    }
  };

  // ── Degraded path: same-source ──
  if (selected === "degraded-same-source") {
    const verdict = {
      verdict: "escalate_to_human",
      provider: "degraded-same-source",
      degraded: "same-source",
      actual_mode: "same-source",
      host,
      availableProviders: effectiveAvailable,
      reviewSnapshot: [{
        path: path.basename(diffFile),
        truncated: false,
        tokenUsage: { total: null },
      }],
      findings: [],
      resolutionSummary:
        host === "unknown"
          ? "Host provider is unknown; pass --host-provider or REVIEW_HOST_PROVIDER. Provider selection failed closed."
          : "No heterologous provider available; review degraded to same-source. Manual review required.",
      riskDisposition: [],
      worktreeInventory: { included: [], unrelated: [], excluded: [] },
      contractPrompt: contract,
      synthetic: true,
      execution_status: "failed",
      trueCrossEngine: false,
      failure_reason: host === "unknown" ? "host-provider-unknown" : "heterologous-provider-unavailable",
    };
    verdict.threatAuditor = runMaterialsAudit();
    fs.writeFileSync(outputFile, JSON.stringify(verdict, null, 2) + "\n");
    return verdict;
  }

  const budget = getDiffCharBudget();
  const packaged = Array.isArray(payload.coverage) && payload.coverage.length > 0;
  const { content: truncatedMaterials, truncated } = packaged
    ? { content: materials, truncated: false }
    : truncateDiff(materials, budget);

  // ── Build prompt ──
  const artifactPackage = payload.canonicalArtifact ? payload.package : null;
  const prompt = buildReviewPrompt({ mode, contract, materialsContent: truncatedMaterials, diffFile, truncated,
    artifactPackage, coverage: payload.coverage });

  // ── Build child env (whitelist) ──
  const childEnv = buildChildEnv(selected, sourceEnv);

  // Claude Code has a canonical direct adapter. No advisor or provider fallback:
  // a Claude failure remains a Claude failure and is diagnosed fail-closed.
  if (selected === "claude-code") {
    // Production launcher trust contract: resolve only from the static trusted
    // PATH allowlist. `claudeBinaryPath` is an explicit dependency-injection
    // seam for deterministic tests/API embedders; CLI callers cannot set it.
    const preflight = claudeBinaryPath
      ? { binaryPath: claudeBinaryPath, version: "test-injected", attempts: [{ binaryPath: claudeBinaryPath, version: "test-injected", compatible: true, rejectionReason: null }] }
      : selectCompatibleClaudeCode({ env: childEnv, candidates: claudeBinaryCandidates });
    const binaryPath = preflight.binaryPath;
    const executeClaude = ({ timeoutMs, promptText = prompt }) => {
      const raw = runViaClaudeCode(binaryPath, promptText, childEnv, timeoutMs, artifactPackage);
      if (artifactPackage && raw.status === 0) {
        const attestation = attestScopedReadStream(raw.stdout, payload.coverage, artifactPackage.root);
        raw.provenance.scopedRead = { valid: attestation.valid, violation: attestation.violation,
          missingCount: attestation.missing.length, missingHashes: attestation.missing.map((p) => createHash("sha256").update(p).digest("hex")),
          toolResultShapes: attestation.toolResultShapes };
        raw.artifactCoverage = attestation.artifactCoverage;
        if (attestation.finalEvent) raw.stdout = JSON.stringify(attestation.finalEvent);
        if (!attestation.valid) { raw.status = 1; raw.error = `scoped Read attestation failed: ${attestation.violation || "missing chunks"}`; raw.errorCode = "EREADATTEST"; }
      }
      return raw;
    };
    let result = binaryPath
      ? runClaudeCodeWithRetry({ execute: ({ timeoutMs }) => executeClaude({ timeoutMs }) })
      : { stdout: "", stderr: "", status: 1, error: "no compatible trusted claude binary found", provenance: { adapter: "claude-code-cli", binaryPath: null, timeoutMs: REVIEW_TIMEOUT_MS } };
    result.provenance.candidatePreflight = preflight.attempts;
    result.provenance.selectedVersion = preflight.version;
    if (result.status === 0) {
      let needsRepair = false;
      try { parseClaudeCodeResult(result.stdout); } catch { needsRepair = true; }
      if (needsRepair) {
        const originalProvenance = result.provenance;
        const originalShape = describeClaudeOutputShape(result.stdout);
        const remaining = Math.max(0, RETRY_TOTAL_BUDGET_MS - (originalProvenance.totalElapsedMs || 0));
        if (remaining > 0 && binaryPath) {
          const repairPrompt = `${prompt}\n\nFORMAT REPAIR (fresh process): Your prior completed response did not match the required JSON schema. Re-review the full original materials above and return ONLY JSON matching this exact schema: ${REVIEW_JSON_SCHEMA}`;
          const repair = executeClaude({ timeoutMs: remaining, promptText: repairPrompt });
          repair.provenance.candidatePreflight = preflight.attempts;
          repair.provenance.selectedVersion = preflight.version;
          repair.provenance.attemptSummaries = originalProvenance.attemptSummaries;
          repair.provenance.maxAttempts = originalProvenance.maxAttempts;
          repair.provenance.totalBudgetMs = originalProvenance.totalBudgetMs;
          repair.provenance.formatRepair = { attempted: true, freshProcess: true, originalShape,
            status: repair.status, outputShape: describeClaudeOutputShape(repair.stdout) };
          result = repair;
        } else {
          result.provenance.formatRepair = { attempted: false, reason: "shared-budget-exhausted", originalShape };
        }
      }
    }
    let verdict;
    let parsedSuccessfully = false;
    const safeEnvelopeMetadata = extractSafeClaudeEnvelopeMetadata(result.stdout);
    try {
      verdict = result.status === 0 ? parseClaudeCodeResult(result.stdout) : null;
      if (!verdict || !VALID_VERDICTS.has(verdict.verdict)) throw new Error("Claude Code result has no valid verdict");
      parsedSuccessfully = true;
    } catch (parseError) {
      const diagnosticPath = writeDiagnostic(outputFile, {
        provider: selected, host, status: result.status, signal: result.signal ?? null,
        errorCode: result.errorCode ?? (result.error ? "SPAWN_ERROR" : null),
        parseError: "INVALID_PROVIDER_OUTPUT",
        stdout: streamMetadata(result.stdout), stderr: streamMetadata(result.stderr),
        envelope: safeEnvelopeMetadata,
        outputShape: describeClaudeOutputShape(result.stdout),
        provenance: { ...result.provenance,
          launcherTrust: claudeBinaryPath ? "explicit-api-injection" : "static-trusted-path-allowlist" },
      });
      verdict = { verdict: "escalate_to_human", provider: selected, host, actual_mode: "not_executed",
        error: result.error ? "Claude Code process failed" : "Claude Code returned invalid structured output",
        diagnosticPath,
        resolutionSummary: "Claude Code review failed; no provider switch was attempted.",
        reviewSnapshot: [], riskDisposition: [], worktreeInventory: { included: [], unrelated: [], excluded: [] } };
    }
    verdict.provider = selected;
    verdict.host = host;
    verdict.provenance = result.provenance;
    verdict.provenance.launcherTrust = claudeBinaryPath
      ? "explicit-api-injection"
      : "static-trusted-path-allowlist";
    verdict.trueCrossEngine = parsedSuccessfully;
    verdict.actual_mode = verdict.trueCrossEngine ? mode : "not_executed";
    verdict.reviewMode = "claude-code-cli";
    verdict.synthetic = !parsedSuccessfully;
    verdict.execution_status = parsedSuccessfully ? "completed" : "failed";
    verdict.backend_provider = "claude-code";
    verdict.reviewer_source = "3rd-review/canonical";
    if (!parsedSuccessfully) {
      verdict.failure_reason = claudeFailureReason(result, safeEnvelopeMetadata);
    }
    verdict.provenance.providerSwitchAttempted = false;
    verdict.provenance.artifactPackage = payload.package;
    verdict.coverage = payload.coverage;
    if (parsedSuccessfully) {
      verdict.artifactCoverage = result.artifactCoverage || payload.coverage.map(({ id, sha256, status }) => ({ id, sha256, status }));
    }
    verdict.findings = Array.isArray(verdict.findings) ? verdict.findings : [];
    verdict.reviewSnapshot = Array.isArray(verdict.reviewSnapshot) ? verdict.reviewSnapshot : [];
    if (payload.coverage.length > 0) {
      verdict.reviewSnapshot = payload.coverage.map((item) => ({
        path: item.path, hash: item.sha256, bytes: item.bytes, truncated: false,
      }));
    }
    verdict.riskDisposition ||= [];
    verdict.worktreeInventory ||= { included: [], unrelated: [], excluded: [] };
    verdict.threatAuditor = runMaterialsAudit();
    fs.writeFileSync(outputFile, JSON.stringify(verdict, null, 2) + "\n");
    return verdict;
  }

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
      actual_mode: "not_executed",
      host,
      error: "omc run-provider-advisor.js not found at ~/.claude/plugins/cache/omc/oh-my-claudecode/*/scripts/; cannot safely execute provider binary without an absolute trusted path.",
      reviewSnapshot: [{
        path: path.basename(diffFile),
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
    verdict.threatAuditor = runMaterialsAudit();
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
    verdict = buildVerdictFromStdout(resolvedOutput, selected, diffFile);
  } catch {
    verdict = {
      verdict: "escalate_to_human",
      provider: selected,
      error: error || `exit=${status}`,
      reviewSnapshot: [{
        path: path.basename(diffFile),
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
    lines: materials.split("\n").length,
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

  // Only mark trueCrossEngine when the advisor actually produced output (status=0, non-empty).
  // A B2 escalate (non-zero exit or empty output) means no real cross-engine review ran.
  const advisorSucceeded = status === 0 && resolvedOutput && resolvedOutput.length > 0;
  if (advisorSucceeded) {
    verdict.trueCrossEngine = true;
  }
  verdict.reviewMode = "omc-ask";

  // actual_mode reflects what genuinely executed, never a blind echo of the
  // requested mode on failure (FR-THIRDREVIEW-001, decision-log D1).
  verdict.actual_mode = advisorSucceeded ? mode : "not_executed";

  // AC-7 / FR-QUALITY-001 dim 4: run threat-auditor in ALL review modes
  verdict.threatAuditor = runMaterialsAudit();

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

// Legacy flags rejected outright (FR-THIRDREVIEW-001): the canonical runner
// entry point has zero stage/round knowledge and must never silently ignore
// these — reject visibly with a non-zero exit, never continue past them.
const LEGACY_FLAG_NAMES = ["stage", "round", "checkpoint"];

if (isMain()) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const prefix = `--${name}=`;
    const found = args.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };

  const usedLegacyFlag = LEGACY_FLAG_NAMES.find(
    (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  );
  if (usedLegacyFlag) {
    console.error(
      `[run-heterologous-review] FAIL: legacy flag --${usedLegacyFlag} is not accepted. ` +
      `The canonical entry point is --diff=<file> --output=<file> only; stage/round routing ` +
      `must be resolved by wh-review before calling this runner (FR-THIRDREVIEW-001).`
    );
    process.exit(1);
  }

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
  const hostProvider = getArg("host-provider");
  const provider = getArg("provider");

  if (!diffFile || !outputFile) {
    console.error("Usage: run-heterologous-review.mjs --diff=<file> --output=<file> [--host-provider=<id>] [--provider=<id>] [--env-strip-check]");
    process.exit(1);
  }

  try {
    runReview({ diffFile, outputFile, hostProvider, provider });
    process.exit(0);
  } catch (e) {
    console.error(`[run-heterologous-review] Fatal error: ${e.message}`);
    process.exit(1);
  }
}
