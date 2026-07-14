import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fail } from "./errors.mjs";

const known = new Set(["claude-code", "kimi", "codex", "opencode"]);
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("CONFIG_INVALID", `${label} must be an object`); return value; }
function string(value, label, nullable = false) { if (nullable && (value === null || value === undefined)) return null; if (typeof value !== "string" || !value) fail("CONFIG_INVALID", `${label} must be a non-empty string`); return value; }
function names(value, label) { if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && envName.test(item))) fail("CONFIG_INVALID", `${label} must contain environment-variable names`); return [...new Set(value)]; }
function positive(value, label, fallback) { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < 1) fail("CONFIG_INVALID", `${label} must be a positive integer`); return value; }
function nonnegative(value, label, fallback) { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < 0) fail("CONFIG_INVALID", `${label} must be a non-negative integer`); return value; }
function attachmentRoots(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("CONFIG_INVALID", "attachment_roots must be an array");
  const seen = new Set();
  return value.map((item, index) => {
    const source = object(item, `attachment_roots[${index}]`); const root = string(source.root, `attachment_roots[${index}].root`);
    if (!path.isAbsolute(root)) fail("CONFIG_INVALID", `attachment_roots[${index}].root must be absolute`);
    let canonical; try { canonical = fs.realpathSync(root); if (!fs.statSync(canonical).isDirectory()) fail("CONFIG_INVALID", `attachment_roots[${index}].root must be a directory`); } catch (error) { if (error?.code === "CONFIG_INVALID") throw error; fail("CONFIG_INVALID", `attachment_roots[${index}].root must exist`); }
    if (seen.has(canonical)) fail("CONFIG_INVALID", `attachment_roots[${index}].root duplicates another root`); seen.add(canonical);
    if (!Array.isArray(source.sources) || source.sources.length === 0 || !source.sources.every((entry) => typeof entry === "string" && entry.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("~") && !part.includes("\\")))) fail("CONFIG_INVALID", `attachment_roots[${index}].sources must contain safe relative prefixes`);
    return { root: canonical, sources: [...new Set(source.sources)] };
  });
}
function fileOnlySandbox(value) {
  if (value === undefined || value === null) return null;
  const source = object(value, "config.file_only_sandbox"); const command = string(source.command, "config.file_only_sandbox.command");
  if (!path.isAbsolute(command)) fail("CONFIG_INVALID", "config.file_only_sandbox.command must be absolute");
  const sha256 = string(source.sha256, "config.file_only_sandbox.sha256");
  if (!/^[a-f0-9]{64}$/i.test(sha256)) fail("CONFIG_INVALID", "config.file_only_sandbox.sha256 must be a SHA-256 hex digest");
  const args = source.args === undefined ? [] : source.args;
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) fail("CONFIG_INVALID", "config.file_only_sandbox.args must be string arguments");
  return { command, args, sha256: sha256.toLowerCase(), trusted: false };
}

export function defaultConfigPath() { return path.join(homedir(), ".config", "3rd-review", "config.json"); }

export function validateConfig(input) {
  const root = object(input, "config");
  if (root.version !== 4) fail("CONFIG_INVALID", "config.version must be 4");
  const runtimeIn = object(root.runtime ?? {}, "config.runtime");
  const runtime = {
    root: string(runtimeIn.root ?? path.join("/tmp", "3rd-review"), "config.runtime.root"),
    ttl_hours: positive(runtimeIn.ttl_hours, "config.runtime.ttl_hours", 24),
    max_prompt_bytes: positive(runtimeIn.max_prompt_bytes, "config.runtime.max_prompt_bytes", 524288),
    max_output_bytes: positive(runtimeIn.max_output_bytes, "config.runtime.max_output_bytes", 10485760),
    max_attachment_bytes: positive(runtimeIn.max_attachment_bytes, "config.runtime.max_attachment_bytes", 10485760),
    liveness_interval_ms: positive(runtimeIn.liveness_interval_ms, "config.runtime.liveness_interval_ms", 1000),
    idle_timeout_ms: nonnegative(runtimeIn.idle_timeout_ms, "config.runtime.idle_timeout_ms", 0),
    max_duration_ms: nonnegative(runtimeIn.max_duration_ms, "config.runtime.max_duration_ms", 360000),
    orphan_timeout_ms: positive(runtimeIn.orphan_timeout_ms, "config.runtime.orphan_timeout_ms", 30000),
  };
  if (!path.isAbsolute(runtime.root)) fail("CONFIG_INVALID", "config.runtime.root must be absolute");
  if (runtime.idle_timeout_ms === 0 && runtime.max_duration_ms === 0) fail("CONFIG_INVALID", "config.runtime.idle_timeout_ms and config.runtime.max_duration_ms cannot both be 0");
  const roots = attachmentRoots(root.attachment_roots); const file_only_sandbox = fileOnlySandbox(root.file_only_sandbox);
  const rawProviders = object(root.providers, "config.providers");
  const providers = {};
  for (const [id, raw] of Object.entries(rawProviders)) {
    if (!known.has(id)) fail("CONFIG_INVALID", `unsupported provider: ${id}`);
    const source = object(raw, `providers.${id}`);
    const auth = object(source.auth ?? { type: "native" }, `providers.${id}.auth`);
    if (!["native", "env"].includes(auth.type)) fail("CONFIG_INVALID", `providers.${id}.auth.type must be native or env`);
    const authEnv = names(auth.env ?? [], `providers.${id}.auth.env`);
    if (auth.type === "env" && authEnv.length === 0) fail("CONFIG_INVALID", `providers.${id}.auth.env is required for env authentication`);
    providers[id] = {
      id, enabled: source.enabled !== false, command: string(source.command, `providers.${id}.command`),
      model: string(source.model, `providers.${id}.model`, true), effort: string(source.effort, `providers.${id}.effort`, true),
      thinking: source.thinking === undefined || source.thinking === null ? null : Boolean(source.thinking),
      auth: { type: auth.type, env: authEnv }, env: names(source.env ?? [], `providers.${id}.env`),
    };
  }
  if (!Array.isArray(root.tiers) || root.tiers.length === 0) fail("CONFIG_INVALID", "config.tiers must be a non-empty array");
  const seen = new Set();
  const tiers = root.tiers.map((tier, i) => {
    if (!Array.isArray(tier) || tier.length === 0) fail("CONFIG_INVALID", `tiers[${i}] must be non-empty`);
    return tier.map((id) => { if (!providers[id]) fail("CONFIG_INVALID", `tiers[${i}] references unknown provider ${id}`); if (seen.has(id)) fail("CONFIG_INVALID", `provider ${id} appears more than once`); seen.add(id); return id; });
  });
  return { version: 4, runtime, attachment_roots: roots, file_only_sandbox, tiers, providers };
}

export function loadConfig(file = defaultConfigPath()) {
  try {
    const requested = path.resolve(file); const config = validateConfig(JSON.parse(fs.readFileSync(requested, "utf8")));
    if (config.file_only_sandbox) {
      const trustedPath = fs.realpathSync(defaultConfigPath()); const actualPath = fs.realpathSync(requested); const stat = fs.lstatSync(actualPath); const owned = stat.uid === process.getuid() || stat.uid === 0;
      config.file_only_sandbox.trusted = actualPath === trustedPath && stat.isFile() && !stat.isSymbolicLink() && owned && (stat.mode & 0o022) === 0;
    }
    return config;
  }
  catch (error) { if (error?.code) throw error; fail("CONFIG_INVALID", `cannot load config ${file}: ${error.message}`); }
}
