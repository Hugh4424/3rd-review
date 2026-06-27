#!/usr/bin/env node
// Resolves 3rd-review runtime preferences into concrete model/effort values.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USER_CONFIG = process.env.REVIEW_DISPATCH_CONFIG || path.join(os.homedir(), ".config", "3rd-review", "review-dispatch-config.json");
const REPO_DEFAULT_CONFIG = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config", "review-dispatch-default.json");

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

function expandHome(p) {
  if (!p || p === "~") return os.homedir();
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function readConfig(file) {
  const explicitFile = file || process.env.AGENTHUB_REVIEW_DISPATCH_CONFIG || "";
  const configFile = expandHome(explicitFile || USER_CONFIG);
  if (!fs.existsSync(configFile)) {
    if (!explicitFile && fs.existsSync(REPO_DEFAULT_CONFIG)) {
      const raw = fs.readFileSync(REPO_DEFAULT_CONFIG, "utf8");
      return { configFile: REPO_DEFAULT_CONFIG, source: "repo_default", config: JSON.parse(raw) };
    }
    return { configFile, source: "not_found", config: {} };
  }
  const raw = fs.readFileSync(configFile, "utf8");
  return { configFile, source: explicitFile ? "explicit_or_env" : "user", config: JSON.parse(raw) };
}

function pickRound(config, round) {
  const n = Number(round || "1");
  return n <= 1 ? config.round1 : config.round2Plus;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function tokenBudget(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function setTokenBudget(target, value) {
  const budget = tokenBudget(value);
  if (budget !== null) target.token_budget = budget;
}

function pickRoleConfig(config, role, round) {
  if (role === "subreviewer") {
    return config.subreviewer?.default || {};
  }
  return pickRound(config.reviewer || {}, round) || {};
}

const role = argValue("role") || "reviewer";
const round = argValue("round") || "1";
const configFileArg = argValue("config-file");
const explicitModel = clean(argValue("explicit-model"));
const explicitEffort = clean(argValue("explicit-effort"));
const format = argValue("format") || "json";

const { configFile, source, config } = readConfig(configFileArg);
const selected = pickRoleConfig(config, role, round);
const reviewerRound = pickRound(config.reviewer || {}, round) || {};
const subreviewerDefault = config.subreviewer?.default || {};
const selectedEffort = clean(selected.thinking_level || selected.effort);

const reviewerConfig = {
  model: clean(reviewerRound.model),
  thinking_level: clean(reviewerRound.thinking_level || reviewerRound.effort),
};
setTokenBudget(reviewerConfig, reviewerRound.token_budget || reviewerRound.tokenBudget);

const subreviewerConfig = {
  model: clean(subreviewerDefault.model),
  thinking_level: clean(subreviewerDefault.thinking_level || subreviewerDefault.effort),
};
setTokenBudget(subreviewerConfig, subreviewerDefault.token_budget || subreviewerDefault.tokenBudget);

const result = {
  source,
  configFile,
  provider: clean(config.provider || "codex") || "codex",
  role,
  round: Number(round || "1"),
  model: explicitModel || clean(selected.model),
  effort: explicitEffort || selectedEffort,
  explicitModel: Boolean(explicitModel),
  explicitEffort: Boolean(explicitEffort),
  reviewer: reviewerConfig,
  subreviewer: subreviewerConfig,
};
setTokenBudget(result, selected.token_budget || selected.tokenBudget);

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

if (format === "shell") {
  console.log(`RESOLVED_PROVIDER=${shellQuote(result.provider)}`);
  console.log(`RESOLVED_MODEL=${shellQuote(result.model)}`);
  console.log(`RESOLVED_EFFORT=${shellQuote(result.effort)}`);
  console.log(`RESOLVED_CONFIG_SOURCE=${shellQuote(result.source)}`);
  console.log(`RESOLVED_CONFIG_FILE=${shellQuote(result.configFile)}`);
  console.log(`RESOLVED_RUNTIME_CONFIG_JSON=${shellQuote(JSON.stringify(result))}`);
} else {
  console.log(JSON.stringify(result, null, 2));
}
