import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { ProtocolError, canonicalConfigHash, validateProviderId } from "./protocol.mjs";

const PROVIDER_FIELDS = new Set(["enabled", "command", "model", "effort", "thinking", "auth_mode", "auth_env", "env_allowlist", "profile", "backend", "config_ref"]);
const ROOT_FIELDS = new Set(["version", "tiers", "providers", "defaults"]);
const AUTH_MODES = new Set(["native_login", "env", "config_ref"]);
const DEFAULT_FIELDS = new Set(["deadline_seconds", "max_input_bytes", "max_output_bytes", "poll_interval_ms", "idle_warning_seconds", "stalled_suspected_seconds", "max_turns", "max_input_tokens", "max_output_tokens", "max_budget_usd"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("CONFIG_INVALID", `${label} must be an object`);
  return value;
}

function string(value, label, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new ProtocolError("CONFIG_INVALID", `${label} must be a non-empty string`);
  return value;
}

function names(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(item))) {
    throw new ProtocolError("CONFIG_INVALID", `${label} must be environment variable names`);
  }
  return [...new Set(value)];
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ProtocolError("CONFIG_INVALID", `${label}.${key} is not allowed`);
}

function defaults(value) {
  const source = object(value ?? {}, "config.defaults");
  rejectUnknown(source, DEFAULT_FIELDS, "config.defaults");
  const output = {};
  for (const [name, item] of Object.entries(source)) {
    if (item !== null && (!Number.isFinite(item) || item < 0 || !Number.isSafeInteger(item))) {
      throw new ProtocolError("CONFIG_INVALID", `config.defaults.${name} must be null or a non-negative safe integer`);
    }
    output[name] = item;
  }
  return output;
}

export function defaultConfigPath() {
  return path.join(homedir(), ".config", "3rd-review", "config.json");
}

export function validateConfig(input) {
  const root = object(input, "config");
  rejectUnknown(root, ROOT_FIELDS, "config");
  if (root.version !== 3) throw new ProtocolError("CONFIG_INVALID", "config.version must be 3");
  const providersInput = object(root.providers, "config.providers");
  const providers = {};
  for (const [id, value] of Object.entries(providersInput)) {
    validateProviderId(id);
    const provider = object(value, `providers.${id}`);
    rejectUnknown(provider, PROVIDER_FIELDS, `providers.${id}`);
    if (typeof provider.enabled !== "boolean") throw new ProtocolError("CONFIG_INVALID", `providers.${id}.enabled must be boolean`);
    providers[id] = {
      enabled: provider.enabled,
      command: string(provider.command, `providers.${id}.command`),
      model: string(provider.model, `providers.${id}.model`, { optional: true }) ?? null,
      effort: string(provider.effort, `providers.${id}.effort`, { optional: true }) ?? null,
      thinking: provider.thinking === undefined || provider.thinking === null ? null : (typeof provider.thinking === "boolean" ? provider.thinking : (() => { throw new ProtocolError("CONFIG_INVALID", `providers.${id}.thinking must be boolean or null`); })()),
      auth_mode: AUTH_MODES.has(provider.auth_mode) ? provider.auth_mode : (() => { throw new ProtocolError("CONFIG_INVALID", `providers.${id}.auth_mode is invalid`); })(),
      auth_env: names(provider.auth_env ?? [], `providers.${id}.auth_env`),
      env_allowlist: names(provider.env_allowlist ?? [], `providers.${id}.env_allowlist`),
      profile: string(provider.profile, `providers.${id}.profile`, { optional: true }) ?? null,
      backend: string(provider.backend, `providers.${id}.backend`, { optional: true }) ?? null,
      config_ref: string(provider.config_ref, `providers.${id}.config_ref`, { optional: true }) ?? null,
    };
  }
  if (!Array.isArray(root.tiers) || root.tiers.length === 0) throw new ProtocolError("CONFIG_INVALID", "config.tiers must be non-empty");
  const acrossTiers = new Set();
  const tiers = root.tiers.map((tier, index) => {
    if (!Array.isArray(tier) || tier.length === 0) throw new ProtocolError("CONFIG_INVALID", `tiers[${index}] must be non-empty`);
    const seen = new Set();
    return tier.map((id) => {
      validateProviderId(id);
      if (!providers[id]) throw new ProtocolError("CONFIG_INVALID", `tiers[${index}] references unknown provider ${id}`);
      if (seen.has(id)) throw new ProtocolError("CONFIG_INVALID", `tiers[${index}] repeats provider ${id}`);
      if (acrossTiers.has(id)) throw new ProtocolError("CONFIG_INVALID", `provider ${id} appears in multiple tiers`);
      seen.add(id);
      acrossTiers.add(id);
      return id;
    });
  });
  const config = { version: 3, tiers, providers, defaults: defaults(root.defaults) };
  const snapshot = canonicalConfigHash(config);
  return { config, config_hash: snapshot.hash, config_snapshot: snapshot.canonical_json };
}

export function loadConfig(file = defaultConfigPath()) {
  let stat; let parsed;
  try { stat = fs.lstatSync(file); } catch (error) { throw new ProtocolError("CONFIG_INVALID", `config is not readable: ${error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new ProtocolError("CONFIG_INVALID", "config must be a private non-symlink file with owner-only permissions (for example 0600)");
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw new ProtocolError("CONFIG_INVALID", `config is not valid JSON: ${error.message}`); }
  return validateConfig(parsed);
}
