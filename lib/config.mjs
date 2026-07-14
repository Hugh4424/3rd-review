import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fail } from "./errors.mjs";

const known = new Set(["claude-code", "kimi", "codex", "opencode"]);
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const sandboxCapabilities = new WeakMap();
export const SYSTEM_FILE_ONLY_POLICY = "/etc/3rd-review/file-only-sandbox-policy.json";
export const SYSTEM_FILE_ONLY_WRAPPER_ROOT = "/usr/local/libexec/3rd-review";

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
  if (value === undefined || value === null) return false;
  const source = object(value, "config.file_only_sandbox");
  if (source.required !== true || Object.keys(source).some((key) => key !== "required")) fail("CONFIG_INVALID", "config.file_only_sandbox may only declare required:true");
  return true;
}
export function validateSystemFileOnlyPolicy(value) {
  const source = object(value, "system file-only policy"); const command = string(source.command, "system file-only policy.command");
  if (!path.isAbsolute(command)) fail("CONFIG_INVALID", "config.file_only_sandbox.command must be absolute");
  const sha256 = string(source.sha256, "system file-only policy.sha256");
  if (!/^[a-f0-9]{64}$/i.test(sha256)) fail("CONFIG_INVALID", "system file-only policy.sha256 must be a SHA-256 hex digest");
  const provider_visible_root = string(source.provider_visible_root, "system file-only policy.provider_visible_root");
  if (!path.posix.isAbsolute(provider_visible_root) || provider_visible_root.includes("..") || provider_visible_root === "/") fail("CONFIG_INVALID", "system file-only policy.provider_visible_root must be a safe virtual absolute path");
  const args = source.args === undefined ? [] : source.args;
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) fail("CONFIG_INVALID", "system file-only policy.args must be string arguments");
  return Object.freeze({ command, args: Object.freeze([...args]), sha256: sha256.toLowerCase(), provider_visible_root });
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
    // Deprecated compatibility inputs. The health runner ignores both.
    idle_timeout_ms: nonnegative(runtimeIn.idle_timeout_ms, "config.runtime.idle_timeout_ms", 360000),
    max_duration_ms: nonnegative(runtimeIn.max_duration_ms, "config.runtime.max_duration_ms", 900000),
    orphan_timeout_ms: positive(runtimeIn.orphan_timeout_ms, "config.runtime.orphan_timeout_ms", 30000),
  };
  if (!path.isAbsolute(runtime.root)) fail("CONFIG_INVALID", "config.runtime.root must be absolute");
  const roots = attachmentRoots(root.attachment_roots); const file_only_required = fileOnlySandbox(root.file_only_sandbox);
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
  return { version: 4, runtime, attachment_roots: roots, file_only_required, file_only_sandbox: null, tiers, providers };
}

export function readSystemFileOnlyPolicy(file = SYSTEM_FILE_ONLY_POLICY) {
  try {
    const resolved = fs.realpathSync(file); const stat = fs.lstatSync(file); const target = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || !target.isFile() || target.uid !== 0 || (target.mode & 0o022) !== 0) fail("CONFIG_INVALID", "system file-only policy must be root-owned, immutable, and non-symlinked");
    return validateSystemFileOnlyPolicy(JSON.parse(fs.readFileSync(resolved, "utf8")));
  } catch (error) { if (error?.code === "ENOENT") return null; if (error?.code) throw error; fail("CONFIG_INVALID", `cannot load system file-only policy: ${error.message}`); }
}
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
export function loadConfig(file = defaultConfigPath()) {
  try {
    const config = validateConfig(JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))); const policy = readSystemFileOnlyPolicy(); const loaded = freeze({ ...config, file_only_sandbox: policy });
    if (policy) sandboxCapabilities.set(loaded, Object.freeze({ fingerprint: JSON.stringify(policy), policy }));
    return loaded;
  }
  catch (error) { if (error?.code) throw error; fail("CONFIG_INVALID", `cannot load config ${file}: ${error.message}`); }
}

export function fileOnlySandboxCapability(config) { const capability = sandboxCapabilities.get(config); if (!capability || config.file_only_sandbox !== capability.policy || JSON.stringify(config.file_only_sandbox) !== capability.fingerprint) return null; return capability.policy; }
