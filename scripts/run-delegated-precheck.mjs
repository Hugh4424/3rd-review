#!/usr/bin/env node
// Runs reviewer-dispatch delegated precheck lenses before the final reviewer.
import { execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Route-rules config (loaded once, FR-LENS-002) ──
const ROUTE_RULES_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config", "route-rules.json");
let _routeRulesCache = null;
function loadRouteRules() {
  if (!_routeRulesCache) {
    try {
      _routeRulesCache = JSON.parse(fs.readFileSync(ROUTE_RULES_PATH, "utf8"));
    } catch {
      _routeRulesCache = {};
    }
  }
  return _routeRulesCache;
}

/**
 * getLensTriggerConfig() — returns the full route-rules.json object.
 * Tests use this to assert that patterns come from config, not hardcoded regexes.
 * The returned object always has a lensTriggers key (or {} if config missing).
 */
export function getLensTriggerConfig() {
  return loadRouteRules();
}

// ── Known false-positives config (FR-BUN-001/002, additive default-off filter) ──
const KNOWN_FALSE_POSITIVES_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "config",
  "known-false-positives.json",
);
let _knownFalsePositivesCache = null;
/**
 * loadKnownFalsePositives() — loads/parses known-false-positives.json.
 * Fails open: missing or unparseable file yields {rules:[]} (no filtering). Never throws.
 */
export function loadKnownFalsePositives() {
  if (!_knownFalsePositivesCache) {
    try {
      const parsed = JSON.parse(fs.readFileSync(KNOWN_FALSE_POSITIVES_PATH, "utf8"));
      _knownFalsePositivesCache = parsed && Array.isArray(parsed.rules) ? parsed : { rules: [] };
    } catch {
      _knownFalsePositivesCache = { rules: [] };
    }
  }
  return _knownFalsePositivesCache;
}

/**
 * isKnownFalsePositive(entry, rules) — true if any ENABLED rule matches entry.
 * matchType: exact (===), substring (.includes), regex (RegExp.test, try/catch → no match).
 * Only enabled === true rules apply. Never throws (bad regex fails open per-rule).
 */
export function isKnownFalsePositive(entry, rules) {
  if (!Array.isArray(rules)) return false;
  for (const rule of rules) {
    if (!rule || rule.enabled !== true) continue;
    const value = String((entry && entry[rule.matchField]) ?? "");
    if (rule.matchType === "exact") {
      if ((entry && entry[rule.matchField]) === rule.pattern) return true;
    } else if (rule.matchType === "substring") {
      if (value.includes(String(rule.pattern))) return true;
    } else if (rule.matchType === "regex") {
      try {
        if (new RegExp(rule.pattern).test(value)) return true;
      } catch {
        // bad regex → no match, never throw
      }
    }
  }
  return false;
}

function argValue(name) {
  const prefix = `--${name}=`;
  const args = process.argv.slice(2);
  const eq = args.find((arg) => arg.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] || "" : "";
}

// Cross-repo apply: when the harness reviews an EXTERNAL delivery repo
// (e.g. workflowhub) while running from this harness repo, `git diff` / cwd
// stripping must target the DELIVERY repo, not the harness repo — otherwise the
// harness repo's own dirty files leak into the changed-file set and the
// subagent lens flags them as out-of-scope high_risk topRisks (FR-TRUST-002
// BLOCK), even though they are not part of the reviewed delivery code. Set via
// --delivery-repo (forwarded by review-dispatch-adapter as $STATUS_REPO).
// Null → fall back to process.cwd() (unchanged single-repo behavior).
let DELIVERY_REPO = null;

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function toStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).filter(Boolean);
}

function normalizeStatus(value) {
  return ["ok", "risk", "fail", "skipped", "not_applicable", "unavailable"].includes(value) ? value : "unavailable";
}

function riskType(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("forbidden")) return "forbidden_touch";
  if (text.includes("scope") || text.includes("boundary")) return "boundary_cross";
  if (text.includes("skill")) return "required_skill_fail";
  if (text.includes("stale")) return "evidence_stale";
  if (text.includes("mismatch")) return "evidence_mismatch";
  if (text.includes("truncated")) return "evidence_truncated";
  if (text.includes("interface")) return "interface_change";
  return "other";
}

function normalizeRiskFlags(value) {
  if (!Array.isArray(value)) return [];
  return value.map((flag) => {
    if (flag && typeof flag === "object") {
      const file = flag.file || flag.target || flag.skill || "";
      const line = flag.line ? `:${flag.line}` : "";
      return {
        type: riskType(flag.type || flag.severity),
        target: String(file || "unknown"),
        description: String(flag.description || flag.detail || flag.issue || JSON.stringify(flag)),
        ...(flag.severity ? { severity: String(flag.severity) } : {}),
        ...(flag.file ? { file: String(flag.file) } : {}),
        ...(flag.line ? { line: Number(flag.line) } : {}),
      };
    }
    return { type: "other", target: "unknown", description: String(flag) };
  });
}

function normalizeCandidateFindings(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((finding) => {
    if (!finding || typeof finding !== "object") return [];
    const file = typeof finding.file === "string" && finding.file ? finding.file : "";
    const line = Number(finding.line || 1);
    const code = typeof finding.code === "string" && finding.code ? finding.code : String(finding.snippet || "");
    const confidence = ["high", "medium", "low"].includes(finding.confidence) ? finding.confidence : "medium";
    const issue = typeof finding.issue === "string" && finding.issue ? finding.issue : "";
    if (!file || !issue) return [];
    return [{
      file,
      line: Number.isInteger(line) && line > 0 ? line : 1,
      code: code || "(no snippet)",
      confidence,
      issue,
      ...(finding.impact ? { impact: String(finding.impact) } : {}),
      ...(finding.recommendation ? { recommendation: String(finding.recommendation) } : {}),
    }];
  });
}

function normalizeRanges(value) {
  if (!Array.isArray(value) || value.length === 0) return ["unknown"];
  return value.map((range) => Array.isArray(range) ? range.join("-") : String(range));
}

function normalizeCoverageProof(value, lens, raw) {
  if (!Array.isArray(value) || value.length === 0) {
    return [{
      file: "review-package",
      ranges: ["prompt"],
      coverageMetric: "structural",
      assertionType: `${lens}:executed`,
      result: "risk",
      digest: digest(raw),
    }];
  }
  return value.map((proof) => {
    const item = proof && typeof proof === "object" ? proof : {};
    const result = ["ok", "risk", "fail"].includes(item.result) ? item.result : "risk";
    const metric = ["line", "structural"].includes(item.coverageMetric) ? item.coverageMetric : "structural";
    return {
      file: String(item.file || "review-package"),
      ranges: normalizeRanges(item.ranges),
      coverageMetric: metric,
      assertionType: String(item.assertionType || `${lens}:coverage`),
      result,
      digest: String(item.digest || digest(item)),
    };
  });
}

function normalizeReport(lens, raw, error) {
  if (error) {
    return {
      status: "unavailable",
      facts: [`${lens} failed: ${error}`],
      riskFlags: [{ type: "other", target: lens, description: String(error) }],
      candidateFindings: [],
      coverageProof: [{
        file: "review-package",
        ranges: ["prompt"],
        coverageMetric: "structural",
        assertionType: `${lens}:unavailable`,
        result: "risk",
        digest: digest(error),
      }],
      mustEscalateToFinal: true,
    };
  }
  return {
    status: normalizeStatus(raw.status),
    facts: toStringList(raw.facts),
    riskFlags: normalizeRiskFlags(raw.riskFlags),
    candidateFindings: normalizeCandidateFindings(raw.candidateFindings),
    coverageProof: normalizeCoverageProof(raw.coverageProof, lens, raw),
    mustEscalateToFinal: Boolean(raw.mustEscalateToFinal),
  };
}

function extractSourceManifestFiles(originalPrompt) {
  // Extract file paths from ## Source Manifest section
  const manifestSection = section(String(originalPrompt || ""), /^## Source Manifest\b/i, 4000);
  const files = [];
  for (const line of manifestSection.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+([\w./][^\s]+)/);
    if (m) files.push(m[1].trim());
  }
  return files;
}

function isHygieneRiskFlag(flag) {
  // boundary_cross type is always hygiene
  if (flag.type === "boundary_cross") return true;
  // Descriptions that explicitly mark a path as unrelated / exclude-before-review are also hygiene
  return /unrelated|exclude before review/i.test(String(flag.description || ""));
}

function buildBundle(reports, originalPrompt) {
  const seen = new Set();
  const candidateFindings = [];
  const topRisks = [];
  const recommendedFinalReadSet = [];
  const readTargets = new Set();
  const coverageAccepted = [];
  // hygieneFlags: riskFlags detected as out-of-scope (boundary_cross or "unrelated / exclude before review")
  const hygieneFlags = [];
  // hygieneInBundleCoalesced: tracks if we already added a "worktree hygiene" entry for boundary_cross
  let bundleHygieneAdded = false;

  for (const report of reports) {
    for (const finding of report.candidateFindings || []) {
      const key = `${finding.file}:${finding.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidateFindings.push(finding);
      }
    }
    if (report.status === "ok" || report.status === "skipped") {
      for (const proof of report.coverageProof || []) {
        if (proof.result === "ok") coverageAccepted.push(proof);
      }
    }
    if (["risk", "fail", "unavailable"].includes(report.status) || report.mustEscalateToFinal) {
      for (const flag of report.riskFlags || []) {
        if (isHygieneRiskFlag(flag)) {
          // Track hygiene flags for finalFacingBundle coalescing
          hygieneFlags.push(flag);
          // Coalesce ALL hygiene flags (boundary_cross AND "unrelated / exclude
          // before review") into a single abstract "worktree hygiene" topRisk.
          // Rationale: a hygiene flag means the path is OUT OF SCOPE and should be
          // excluded before review — it is NOT a block the reviewer must open. Both
          // types must therefore coalesce to the abstract target so review-persist's
          // FR-TRUST-002 coverage check treats it as warn-only (is_real_file=false),
          // never a BLOCK. Previously only boundary_cross coalesced; the
          // "unrelated/exclude" branch leaked the RAW file path as a real-file
          // high_risk, contradicting the finalFacingBundle contract below (no raw
          // unrelated paths exposed) and making concurrent OTHER-task untracked
          // specs/test fixtures BLOCK this task's pass at persist.
          topRisks.push({ sourceType: "high_risk", target: "worktree hygiene", reason: `[${flag.type}] ${flag.description}` });
          if (!bundleHygieneAdded) {
            bundleHygieneAdded = true;
            readTargets.add("worktree hygiene");
            recommendedFinalReadSet.push({
              sourceType: "high_risk",
              target: "worktree hygiene",
              reason: "out-of-scope worktree path(s) coalesced; inspect git status --short or hygiene inventory summary only",
            });
          }
          continue;
        }

        topRisks.push({
          sourceType: "high_risk",
          target: flag.target,
          reason: `[${flag.type}] ${flag.description}`,
        });

        // Promote riskFlag with file:line target to candidateFindings
        const fileLineMatch = /^(.+):(\d+)$/.exec(String(flag.target || ""));
        if (fileLineMatch) {
          const file = fileLineMatch[1];
          const line = Number(fileLineMatch[2]);
          const candidateKey = `${file}:${line}`;
          if (!seen.has(candidateKey)) {
            seen.add(candidateKey);
            candidateFindings.push({
              file,
              line,
              code: "(no snippet)",
              confidence: "medium",
              issue: String(flag.description || flag.target),
            });
          }
          if (!readTargets.has(flag.target)) {
            readTargets.add(flag.target);
            recommendedFinalReadSet.push({ sourceType: "candidate", target: flag.target, reason: String(flag.description || "") });
          }
        } else {
          // Plain file path — check for task ID (T###) in description to promote to candidateFindings
          const taskIdMatch = /\bT(\d{3,4})\b/.exec(String(flag.description || ""));
          if (taskIdMatch && flag.target && !String(flag.target).includes("*")) {
            const taskKey = `task:${flag.target}:${taskIdMatch[0]}`;
            if (!seen.has(taskKey)) {
              seen.add(taskKey);
              candidateFindings.push({
                file: String(flag.target),
                line: 1,
                code: "(no snippet)",
                confidence: "medium",
                issue: String(flag.description || flag.target),
              });
            }
          }
          if (!readTargets.has(flag.target)) {
            readTargets.add(flag.target);
            recommendedFinalReadSet.push({
              sourceType: "high_risk",
              target: flag.target,
              reason: String(flag.description || ""),
            });
          }
        }
      }
      // Promote high-risk facts containing FR references to candidateFindings
      if (originalPrompt) {
        const manifestFiles = extractSourceManifestFiles(originalPrompt);
        const planFile = manifestFiles.find((f) => /\bplan\.md$/.test(f)) || null;
        for (const fact of report.facts || []) {
          const frMatch = /\bFR-[A-Z0-9-]+/.exec(String(fact));
          if (frMatch && planFile) {
            const factKey = `fact:${planFile}:${frMatch[0]}`;
            if (!seen.has(factKey)) {
              seen.add(factKey);
              candidateFindings.push({
                file: planFile,
                line: 1,
                code: "(no snippet)",
                confidence: "medium",
                issue: String(fact),
              });
            }
          }
        }
      }
      for (const finding of report.candidateFindings || []) {
        const target = `${finding.file}:${finding.line}`;
        topRisks.push({ sourceType: "candidate", target, reason: finding.issue });
        if (!readTargets.has(target)) {
          readTargets.add(target);
          recommendedFinalReadSet.push({ sourceType: "candidate", target, reason: finding.issue });
        }
      }
    }
  }

  const bundle = { mode: "delegated", topRisks, candidateFindings, recommendedFinalReadSet, coverageAccepted };

  // finalFacingBundle: all hygiene-detected paths (boundary_cross AND "unrelated/exclude") coalesced
  // into a single "worktree hygiene" entry. No raw unrelated paths exposed to the final reviewer.
  if (hygieneFlags.length > 0) {
    const hygieneKey = "worktree hygiene";
    const hygieneTargets = new Set(hygieneFlags.map((f) => String(f.target || "")));
    // Filter topRisks: remove hygiene-path entries, replace with single "worktree hygiene"
    const filteredTopRisks = topRisks.filter((entry) => !hygieneTargets.has(String(entry.target || "")) || entry.target === hygieneKey);
    if (!filteredTopRisks.some((e) => e.target === hygieneKey)) {
      filteredTopRisks.push({ sourceType: "high_risk", target: hygieneKey, reason: `[hygiene] ${hygieneFlags.length} out-of-scope path(s) coalesced` });
    }
    // Filter recommendedFinalReadSet: remove hygiene-path entries, add "worktree hygiene" if not present
    const filteredReadSet = recommendedFinalReadSet.filter((entry) => !hygieneTargets.has(String(entry.target || "")) || entry.target === hygieneKey);
    if (!filteredReadSet.some((e) => e.target === hygieneKey)) {
      filteredReadSet.push({
        sourceType: "high_risk",
        target: hygieneKey,
        reason: `${hygieneFlags.length} out-of-scope worktree path(s) coalesced; inspect git status --short or hygiene inventory summary only`,
      });
    }
    const finalFacingBundle = { mode: "delegated", topRisks: filteredTopRisks, candidateFindings, recommendedFinalReadSet: filteredReadSet, coverageAccepted };
    return { bundle, finalFacingBundle: applyKnownFalsePositiveFilter(finalFacingBundle) };
  }

  return { bundle, finalFacingBundle: applyKnownFalsePositiveFilter(bundle) };
}

/**
 * applyKnownFalsePositiveFilter(finalFacingBundle) — FR-BUN-001/002.
 * Additive default-off noise filter: drops topRisks/candidateFindings entries matching an
 * ENABLED known-false-positive rule. Only the FINAL-FACING bundle (reviewer prompt) is filtered,
 * never the internal coverage-bookkeeping bundle. Empty/disabled config ⇒ byte-identical output.
 */
function applyKnownFalsePositiveFilter(finalFacingBundle, rulesOverride) {
  // rulesOverride: optional explicit rules array (test injection); defaults to loaded config.
  const rules = Array.isArray(rulesOverride) ? rulesOverride : (loadKnownFalsePositives().rules || []);
  if (!rules.some((r) => r && r.enabled === true)) return finalFacingBundle;
  return {
    ...finalFacingBundle,
    topRisks: (finalFacingBundle.topRisks || []).filter((e) => !isKnownFalsePositive(e, rules)),
    candidateFindings: (finalFacingBundle.candidateFindings || []).filter((e) => !isKnownFalsePositive(e, rules)),
    // FR-BUN-001: recommendedFinalReadSet is also prompt-facing — a known FP here would still
    // reach the reviewer prompt. Filter all three prompt-facing bundle sections.
    recommendedFinalReadSet: (finalFacingBundle.recommendedFinalReadSet || []).filter((e) => !isKnownFalsePositive(e, rules)),
  };
}

function runtimeReport(lens, raw, resultFile) {
  const cfg = raw?._runtimeConfig || {};
  const meta = raw?._codexMeta || {};
  const requestedModel = cfg.model || cfg.subreviewer?.model || meta.model || "unknown";
  const requestedEffort = cfg.effort || cfg.subreviewer?.thinking_level || meta.effort || "unknown";
  const sessionModel = meta.model || null;
  const sessionEffort = meta.effort || null;
  const effectiveModel = sessionModel || requestedModel;
  const effectiveEffort = sessionEffort || requestedEffort;
  const modelEvidence = sessionModel ? "codex session meta" : "requested config fallback";
  const effortEvidence = sessionEffort ? "codex session meta" : "requested config fallback";
  return {
    name: lens,
    requestedModel,
    requestedEffort,
    requestedTokenBudget: cfg.token_budget || cfg.subreviewer?.token_budget || null,
    sessionModel,
    sessionEffort,
    modelEvidence,
    effortEvidence,
    effectiveModel,
    effectiveEffort,
    sessionFile: meta.sessionFile || resultFile,
    elapsedSec: typeof meta.elapsedSec === "number" ? meta.elapsedSec : undefined,
    tokenUsageSource: meta.tokens ? "codex session meta" : "subreviewer result file; codex session token meta unavailable",
    ...(meta.tokens ? { tokenUsage: meta.tokens } : {}),
  };
}

function bounded(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function section(text, headingPattern, maxChars) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s+\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return bounded(lines.slice(start, end).join("\n"), maxChars);
}

function extractSection(text, headingPattern) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start < 0) return "";
  let end = lines.length;
  const startLevel = (lines[start].match(/^#+/) || [""])[0].length || 2;
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#+)\s+\S/);
    if (match && match[1].length <= startLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function grepLines(text, patterns, maxLines) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) {
      out.push(line);
      if (out.length >= maxLines) break;
    }
  }
  return out.join("\n");
}

function safeExec(cmd, options = {}) {
  try {
    return execSync(cmd, {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      timeout: options.timeout || 10000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readIfExists(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function readJsonIfExists(file) {
  try {
    return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

function uniqueList(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parseDelegatedLensPlan(originalPrompt) {
  const block = extractSection(originalPrompt, /^##\s+Delegated Lens Plan\b/i);
  if (!block) return [];
  const fenced = block.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenced ? fenced[1] : block).trim();
  try {
    const parsed = JSON.parse(jsonText);
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.lenses) ? parsed.lenses : [];
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const name = String(entry.name || entry.lens || "").trim();
      if (!name) return [];
      return [{
        name,
        role: String(entry.role || entry.purpose || ""),
        checks: Array.isArray(entry.checks) ? entry.checks.map((item) => String(item)) : [],
        sliceHints: Array.isArray(entry.sliceHints) ? entry.sliceHints.map((item) => String(item)) : [],
      }];
    });
  } catch {
    return [];
  }
}

function dynamicLens(name, role, checks, sliceHints) {
  return { name, role, checks, sliceHints };
}

function decision(lens, source, reason, signals) {
  return {
    lens,
    source,
    reason,
    signals: uniqueList(signals),
  };
}

/**
 * Classify a checkpoint ID into a review kind string.
 * Returns clean kind values matching plan.md requirements:
 * - intake-direction, intake-detail (without `-review` suffix)
 * - plan-review, design-review, code-review, test-acceptance (existing)
 * Returns null for unrecognized checkpoints.
 */
export function reviewKindFor(checkpointId) {
  if (!checkpointId || typeof checkpointId !== "string") return null;
  const id = checkpointId.toLowerCase();
  if (id.startsWith("plan-review") || id === "plan") return "plan-review";
  if (id.startsWith("design-review") || id === "design") return "design-review";
  if (id.startsWith("code-review")) return "code-review";
  if (id.startsWith("test-acceptance")) return "test-acceptance";
  if (id.startsWith("intake-direction-review")) return "intake-direction";
  if (id.startsWith("intake-detail-review")) return "intake-detail";
  return null;
}

function inferAutomaticLensPlan(originalPrompt, checkpointId) {
  const text = String(originalPrompt || "");
  const lower = text.toLowerCase();
  const checkpoint = String(checkpointId || extractPromptField(originalPrompt, "checkpoint") || "").toLowerCase();
  const specs = [];
  const decisions = [];
  const add = (spec, reason, signals) => {
    specs.push(spec);
    decisions.push(decision(spec.name, "automatic", reason, signals));
  };

  // ── Config-driven content signals (FR-LENS-001/002): patterns read from route-rules.json ──
  // Checkpoint-prefix logic (isPlan/isDesign/etc.) stays in code — only content regexes move to config.
  const lt = (loadRouteRules().lensTriggers) || {};

  // Helper: test text against an array of regex pattern strings from config.
  // Each string is compiled as a regex with 'i' flag unless it starts with '^' (multiline).
  function matchesAny(patterns, haystack, flags) {
    if (!Array.isArray(patterns)) return false;
    return patterns.some((p) => {
      try { return new RegExp(p, flags !== undefined ? flags : "i").test(haystack); } catch { return false; }
    });
  }

  // sourceManifestKeywords index 2 ("^diff --git ") must be tested multiline.
  // We test all sourceManifestKeywords case-insensitively EXCEPT the multiline one.
  // For simplicity: test each pattern individually with appropriate flags.
  function matchesSourceManifest(patterns, text) {
    if (!Array.isArray(patterns)) {
      // Hardcoded fallback (should not reach here if config is correct)
      return /##\s+Source Manifest/i.test(text) || /##\s+Delta Package/i.test(text) || /^diff --git /m.test(text) || /Precomputed Changed File Classification/i.test(text);
    }
    return patterns.some((p, idx) => {
      try {
        // "^diff --git " needs multiline to match line-start
        const flags = p.startsWith("^") ? "m" : "i";
        return new RegExp(p, flags).test(text);
      } catch { return false; }
    });
  }

  // Derive the four source signals from config patterns (backward-compat: split by semantic role)
  const _smPatterns = Array.isArray(lt.sourceManifestKeywords) ? lt.sourceManifestKeywords : [];
  // hasSourceManifest: first keyword ("##\s+Source Manifest")
  const hasSourceManifest = _smPatterns.length > 0
    ? (() => { try { return new RegExp(_smPatterns[0], "i").test(text); } catch { return false; } })()
    : /##\s+Source Manifest/i.test(text);
  // hasDiff: keywords 1 ("##\s+Delta Package") and 2 ("^diff --git ")
  const hasDiff = _smPatterns.length > 1
    ? (() => {
        try { if (new RegExp(_smPatterns[1], "i").test(text)) return true; } catch { /* */ }
        try { if (_smPatterns[2] && new RegExp(_smPatterns[2], "m").test(text)) return true; } catch { /* */ }
        return false;
      })()
    : /##\s+Delta Package/i.test(text) || /^diff --git /m.test(text);
  // hasChangedClassification: keyword 3 ("Precomputed Changed File Classification")
  const hasChangedClassification = _smPatterns.length > 3
    ? (() => { try { return new RegExp(_smPatterns[3], "i").test(text); } catch { return false; } })()
    : /Precomputed Changed File Classification/i.test(text);

  const hasRequiredSkill = matchesAny(lt.requiredSkillKeywords, text);
  const hasEvidence = matchesAny(lt.evidenceKeywords, text);
  const hasMechanicalRisk = matchesAny(lt.mechanicalRiskKeywords, text);
  const hasUiRaw = matchesAny(lt.uiKeywords, lower);
  // Strong-signal-v4: plan checkpoint suppresses weak text signals for test-acceptance and design detection.
  // acceptance-baseline.md, spec.md, decision-log.md, "acceptance criteria" in plan review body
  // must not trigger acceptance lens or design-intent lens.
  const isPlan = checkpoint.startsWith("build-plan") || checkpoint.startsWith("plan") || /review kind:\s*plan\b|##\s+Plan Review Package\b|##\s+Plan\b/i.test(text);
  // Strong-signal-v4 extension: a design checkpoint must also suppress weak test-acceptance text
  // signals. A design spec legitimately contains "acceptance criteria" (验收清单); without this guard
  // design-review fires the test-acceptance-only evidence-freshness lens, which returns
  // status=unavailable (no apply/evidence exists in design) and hard-stalls the round. Authoritative
  // checkpoint prefix wins over weak body text; explicit test-acceptance-* checkpoints still trigger.
  const isDesignCheckpoint = checkpoint.startsWith("design");
  const isTestAcceptance = checkpoint.startsWith("test-acceptance") || (!isPlan && !isDesignCheckpoint && /final test report|acceptance baseline|acceptance criteria/i.test(text));
  // design-intent requires explicit design checkpoint or non-plan design signals
  const isDesign = checkpoint.startsWith("design") || (!isPlan && /##\s+Spec\b|decision-log|scenario/i.test(text));
  // intake-direction/intake-detail: record-only review kinds (FR-REVIEW-001)
  const reviewKind = reviewKindFor(checkpoint);
  const isIntake = Boolean(reviewKind) && reviewKind.startsWith("intake-");
  // hasUi: derived from config uiKeywords (computed above as hasUiRaw, or hardcoded fallback if config missing)
  const hasUi = hasUiRaw !== undefined
    ? hasUiRaw
    : /ui\b|browser|screenshot|trace|isolated-browser-qa|responsive|user-flow|ui_change/i.test(lower);
  const hasReviewableScope = checkpoint.startsWith("code-review") || hasDiff || hasChangedClassification;

  // ── FR-LENS-003: high-risk detection for full-lens fallback ──
  // Detect high-risk content by checking route-rules.json scope.riskKeywords against the prompt text.
  // When fullFallbackOnHighRisk=true and high-risk is detected, force all core lenses.
  const riskKeywords = (loadRouteRules().scope && loadRouteRules().scope.riskKeywords && loadRouteRules().scope.riskKeywords.keywords) || [];
  const isHighRisk = riskKeywords.length > 0 && riskKeywords.some((kw) => text.includes(kw));
  const fullFallbackOnHighRisk = lt.fullFallbackOnHighRisk === true;
  const fullFallbackOnNoMatch = lt.fullFallbackOnNoMatch === true;

  // FR-LENS-003: high-risk full-lens fallback forces the full core code-review lens set,
  // not just required-skill-auditor. Without this, a high-risk change with no diff/no
  // code-review checkpoint would only mount required-skill-auditor and skip source/evidence/
  // scope/mechanical审查 — degrading the fail-safe into under-review.
  const forceFullLens = isHighRisk && fullFallbackOnHighRisk;

  if (hasSourceManifest || hasDiff || hasChangedClassification || isIntake || forceFullLens) {
    add(
      { name: "source-manifest-auditor", promptSpec: null },
      "Review package exposes source manifest or changed-file inventory.",
      [
        hasSourceManifest ? "Source Manifest" : "",
        hasDiff ? "Delta Package/diff" : "",
        hasChangedClassification ? "Changed File Classification" : "",
      ],
    );
  }
  if (hasRequiredSkill || isDesign || isIntake || isPlan || isTestAcceptance || forceFullLens) {
    add(
      { name: "required-skill-auditor", promptSpec: null },
      "Checkpoint or package contains mandatory skill requirements.",
      [
        hasRequiredSkill ? "required skill signal" : "",
        isDesign ? "design checkpoint" : "",
        isPlan ? "plan checkpoint/package" : "",
        isTestAcceptance ? "test-acceptance checkpoint/package" : "",
        forceFullLens ? "high-risk full-lens fallback" : "",
      ],
    );
  }
  // Strong-signal-v4 fix: plan review must not trigger evidence-freshness on weak text signals.
  // Skill names like "verify-change" appearing in plan body (FR-SKILL-002 classification table)
  // would otherwise match hasEvidence and select a lens that needs apply/evidence (absent in plan),
  // hard-stalling plan review. Gate hasEvidence behind !isPlan; explicit code-review checkpoint still triggers.
  // Same fix extended to design review: spec bodies legitimately mention "exit code"/"exit 0" (e.g. an
  // FR describing false-green lint patterns) which trips hasEvidence; design has no apply/evidence/ either,
  // so the lens fails and fail-closes the whole review. Gate hasEvidence behind !isDesign as well.
  if ((!isPlan && !isDesign && hasEvidence) || checkpoint.startsWith("code-review") || isIntake || isTestAcceptance || forceFullLens) {
    add(
      { name: "evidence-freshness-auditor", promptSpec: null },
      "Review package contains verification or evidence freshness claims.",
      [
        hasEvidence ? "evidence/verify signal" : "",
        checkpoint.startsWith("code-review") ? "code-review checkpoint" : "",
        isTestAcceptance ? "test-acceptance checkpoint/package" : "",
      ],
    );
  }
  if (hasReviewableScope || forceFullLens) {
    add(
      { name: "scope-boundary-auditor", promptSpec: null },
      "Scope boundary review is actionable because changed files or code-review scope are visible.",
      [
        checkpoint.startsWith("code-review") ? "code-review checkpoint" : "",
        hasDiff ? "Delta Package/diff" : "",
        hasChangedClassification ? "Changed File Classification" : "",
      ],
    );
  }
  if (hasMechanicalRisk || checkpoint.startsWith("code-review") || forceFullLens) {
    add(
      { name: "mechanical-grep-auditor", promptSpec: null },
      "Mechanical risk scan is available or required for code review.",
      [
        hasMechanicalRisk ? "mechanical grep input" : "",
        checkpoint.startsWith("code-review") ? "code-review checkpoint" : "",
      ],
    );
  }

  // FR-LENS-003 (no-match path): when fullFallbackOnNoMatch is enabled and NONE of the core
  // code-review lenses fired (no signals matched), force the full core lens set — same fail-safe
  // semantics as forceFullLens for high-risk. spec.md FR-LENS-003 Given is "high-risk OR no rule
  // matched"; both must fall back to the full CODE-REVIEW lens set, not just input-contract-auditor.
  // Gate on !isPlan && !isDesign && !isTestAcceptance && !isIntake: those checkpoints have their
  // own lens plans and must not be treated as "no-match" code-review cases.
  //
  // FR-LENS-003 "full lens fallback" scope (spec clarified 2026-06-19, user-approved): the fallback
  // mounts the 5 CORE code-review lenses below. The other 7 checkpoint-specific lenses
  // (browser-qa / acceptance-evidence / verifier-closure / plan-traceability / design-intent /
  // threat-modeling / input-contract) are NOT force-mounted here: blindly mounting them on a
  // code-review change demands artifacts that do not exist (e.g. plan-traceability needs a plan)
  // and hard-stalls the round — the exact failure strong-signal-v4 already guards against. The
  // spec's legacy "7 个 lens" wording referred to the pre-task sub-reviewer count and is reconciled
  // to "5 核心 code-review lens 全派" in decision-log. CORE_LENSES IS the full code-review fallback set.
  const CORE_LENSES = ["source-manifest-auditor", "required-skill-auditor", "evidence-freshness-auditor", "scope-boundary-auditor", "mechanical-grep-auditor"];
  const coreFired = specs.some((s) => CORE_LENSES.includes(s.name));
  if (fullFallbackOnNoMatch && !coreFired && !isPlan && !isDesign && !isTestAcceptance && !isIntake) {
    for (const lensName of CORE_LENSES) {
      if (!specs.some((s) => s.name === lensName)) {
        add({ name: lensName, promptSpec: null }, "FR-LENS-003 no-match full-lens fallback: no lens signals detected, mounting full core lens set.", ["no-match full-lens fallback"]);
      }
    }
  }

  if (isTestAcceptance) {
    add(
      {
        name: "acceptance-evidence-auditor",
        promptSpec: dynamicLens(
          "acceptance-evidence-auditor",
          "Map acceptance criteria, acceptance baseline items, and final test report claims to current raw evidence.",
          [
            "List acceptance criteria or baseline items visible in the slice.",
            "Flag criteria whose PASS claim lacks raw command output, exit code, timestamp, current git SHA, or evidence path.",
            "Check whether required qa-only and verify-change --light evidence is present and current.",
          ],
          ["acceptance", "baseline", "final-test-report", "qa-only", "verify-change", "PASS", "exit code"],
        ),
      },
      "Test-acceptance package needs acceptance claims mapped to raw evidence.",
      ["test-acceptance checkpoint/package", "acceptance evidence"],
    );
    if (/verifier-report-index|reviews\.jsonl|fix_status|open|in_progress/i.test(text)) {
      add(
        {
          name: "verifier-closure-auditor",
          promptSpec: dynamicLens(
            "verifier-closure-auditor",
            "Check whether verifier closure state proves this checkpoint can advance.",
            [
              "Inspect visible verifier index and reviews references.",
              "Flag open or in_progress closure state.",
              "Flag missing current checkpoint pass/revise/escalate row.",
            ],
            ["verifier-report-index", "reviews.jsonl", "fix_status", "open", "in_progress"],
          ),
        },
        "Verifier index or fix-status closure state is visible.",
        ["verifier-report-index/reviews.jsonl", "fix_status/open/in_progress"],
      );
    }
    if (hasUi) {
      add(
        {
          name: "browser-qa-auditor",
          promptSpec: dynamicLens(
            "browser-qa-auditor",
            "Check whether UI/browser QA evidence is appropriate for the current acceptance scope.",
            [
              "Identify UI/browser/user-flow scope.",
              "If UI scope exists, check for isolated-browser-qa, screenshot, trace, or equivalent evidence.",
              "If UI scope is absent, check for a clear non-UI QA rationale.",
            ],
            ["ui_change", "browser", "isolated-browser-qa", "screenshot", "trace", "qa-only"],
          ),
        },
        "Acceptance package contains UI/browser QA signals.",
        ["ui/browser/screenshot/trace signal"],
      );
    }
  }

  if (isPlan) {
    add(
      {
        name: "plan-traceability-auditor",
        promptSpec: dynamicLens(
          "plan-traceability-auditor",
          "Map visible FRs to tasks and objective verification.",
          [
            "List visible FR ids.",
            "Identify tasks and verify steps tied to those FRs.",
            "Flag FRs with missing or prose-only verification.",
          ],
          ["FR-", "T0", "Verify", "Success Criteria", "Depends On"],
        ),
      },
      "Checkpoint or package explicitly identifies a plan review.",
      ["plan checkpoint/package"],
    );
  }

  if (isDesign) {
    add(
      {
        name: "design-intent-auditor",
        promptSpec: dynamicLens(
          "design-intent-auditor",
          "Check whether visible intake, decision-log, and user intent are reflected in design requirements or explicit non-goals.",
          [
            "Map visible intake and decision-log references to FRs or scenarios.",
            "Flag unmapped user intent that is neither covered nor explicitly excluded.",
            "Flag implementation details that over-constrain the design when visible.",
          ],
          ["intake", "decision-log", "FR-", "scenario", "Non-Goal", "不做"],
        ),
      },
      "Checkpoint or package contains design-intent signals.",
      [
        checkpoint.startsWith("design") ? "design checkpoint" : "",
        "spec/decision-log/intake/scenario signal",
      ],
    );
    add(
      {
        name: "threat-modeling-auditor",
        promptSpec: dynamicLens(
          "threat-modeling-auditor",
          "Surface adversarial defects in the design spec across three categories: forgery-bypass, proof-independence, schema-drift.",
          [
            "Identify attestation and persist mechanisms; flag patterns where the same principal can construct and inject evidence (forgery-bypass).",
            "Identify reviewer/verifier roles; flag patterns where the orchestrator controls verifier inputs or shares context with the reviewer (proof-independence).",
            "Identify structured output contracts; flag absent or soft-fail machine validation, conflicting field definitions, and per-item adjudication without enforcement (schema-drift).",
          ],
          ["forgery", "bypass", "proof", "independence", "schema", "drift", "AJV", "验证", "造假", "独立"],
        ),
      },
      "Design checkpoint: threat-modeling adversarial audit auto-mounted.",
      [
        checkpoint.startsWith("design") ? "design checkpoint" : "",
        "threat-modeling adversarial audit",
      ],
    );
  }

  if (specs.length === 0) {
    add(
      {
        name: "input-contract-auditor",
        promptSpec: dynamicLens(
          "input-contract-auditor",
          "Check whether the review package provides enough source and contract information for final review.",
          [
            "Inspect checkpoint metadata, Source Manifest, Required Read Set, and contract references.",
            "Flag missing required source pointers or ambiguous taskDir/repoRoot/checkpoint metadata.",
          ],
          ["checkpoint", "Source Manifest", "Required Read Set", "contract", "repoRoot", "taskDir"],
        ),
      },
      "No specific review lens signals were detected.",
      ["fallback"],
    );
  }

  return { specs, decisions };
}
export { inferAutomaticLensPlan };

/**
 * buildLensContext(lens, originalPrompt)
 *
 * Returns the context string that would be fed to the given lens during a
 * delegated precheck run. This is the public test surface for T018: callers
 * can assert that spec text is present in the returned context for design
 * lenses such as "threat-modeling-auditor".
 *
 * Implementation: thin wrapper over lensSlice, which already encodes all
 * byLens routing. Exported so tests can import it without running the full
 * precheck pipeline.
 */
export function buildLensContext(lens, originalPrompt) {
  return lensSlice(lens, originalPrompt, null);
}

function resolveLensSpecs(configFile, checkpointId, originalPrompt) {
  const config = readJsonIfExists(configFile) || {};
  const lenses = config && typeof config === "object" ? config.lenses || {} : {};
  const base = Array.isArray(lenses.default) ? lenses.default : [];
  const routes = Array.isArray(lenses.routes) ? lenses.routes : [];
  const extras = [];
  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    const pattern = String(route.checkpointPattern || "");
    if (!pattern || !Array.isArray(route.lenses)) continue;
    try {
      if (new RegExp(pattern).test(String(checkpointId || ""))) {
        extras.push(...route.lenses);
      }
    } catch {
      // Invalid user route patterns are ignored by precheck and surfaced by config tests.
    }
  }
  const promptPlan = parseDelegatedLensPlan(originalPrompt);
  const promptLensNames = promptPlan.map((item) => item.name);
  const automatic = inferAutomaticLensPlan(originalPrompt, checkpointId);
  const automaticSpecs = automatic.specs;
  const automaticNames = automaticSpecs.map((item) => item.name);
  const names = uniqueList([...automaticNames, ...base, ...extras, ...promptLensNames]);
  const automaticByName = new Map(automaticSpecs.map((item) => [item.name, item.promptSpec || null]));
  const promptByName = new Map(promptPlan.map((item) => [item.name, item]));
  const decisions = [];
  const automaticDecisionByName = new Map(automatic.decisions.map((item) => [item.lens, item]));
  for (const name of names) {
    if (automaticDecisionByName.has(name)) {
      decisions.push(automaticDecisionByName.get(name));
    } else if (promptByName.has(name)) {
      decisions.push(decision(name, "prompt", "Review package declared this dynamic lens in Delegated Lens Plan.", ["Delegated Lens Plan"]));
    } else if (base.includes(name)) {
      decisions.push(decision(name, "config.default", "Runtime config default lens requested this lens.", ["config.lenses.default"]));
    } else {
      decisions.push(decision(name, "config.route", "Runtime config route requested this lens.", ["config.lenses.routes"]));
    }
  }
  return {
    specs: names.map((name) => ({ name, promptSpec: promptByName.get(name) || automaticByName.get(name) || null })),
    decisions,
  };
}

function repoFile(...parts) {
  return path.resolve(process.cwd(), ...parts);
}

function headingBlock(text, pattern, maxChars) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) return "";
  let end = lines.length;
  const startLevel = (lines[start].match(/^#+/) || [""])[0].length || 2;
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#+)\s+\S/);
    if (match && match[1].length <= startLevel) {
      end = i;
      break;
    }
  }
  return bounded(lines.slice(start, end).join("\n"), maxChars);
}

function contractContext(kind) {
  const workflowContract = readIfExists(repoFile("packages/core/agenthub/workflows/vibecoding/contract.md"));
  const codeContract = readIfExists(repoFile("verifiers/vibecoding/build-code-reviewer-contract.md"));
  const chunks = [];
  if (kind === "required-skill") {
    chunks.push(headingBlock(workflowContract, /^## 强制技能门禁/, 9000));
    chunks.push(headingBlock(workflowContract, /^### 按触发时机分组/, 8000));
    chunks.push(headingBlock(codeContract, /^## 三轴审查/, 4000));
  } else if (kind === "scope-boundary") {
    chunks.push(headingBlock(workflowContract, /^### Upstream 合并守卫/, 9000));
    chunks.push(headingBlock(codeContract, /^## 阻断\/非阻断分类/, 6000));
    chunks.push(headingBlock(codeContract, /^## 检查维度/, 5000));
  } else if (kind === "source-manifest") {
    chunks.push(headingBlock(codeContract, /^## 阻断\/非阻断分类/, 6000));
    chunks.push(headingBlock(codeContract, /^## 检查维度/, 5000));
  }
  return [
    `## Contract Context (${kind})`,
    chunks.filter(Boolean).join("\n\n") || "(contract context unavailable)",
  ].join("\n");
}

function changedFiles(originalPrompt) {
  const files = new Set();
  const diffHeader = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match;
  while ((match = diffHeader.exec(originalPrompt)) !== null) {
    const normalized = normalizeRepoPath(match[2]);
    if (normalized) files.add(normalized);
  }
  // Cross-repo: list changed files from the DELIVERY repo (workflowhub), not the
  // harness repo. Without this cwd, the harness repo's own dirty files leak into
  // the changed-file set and the lens flags them as out-of-scope high_risk.
  const diffCwd = DELIVERY_REPO || process.cwd();
  for (const cmd of ["git diff --name-only", "git diff --cached --name-only"]) {
    for (const line of safeExec(cmd, { cwd: diffCwd }).split(/\r?\n/)) {
      const normalized = normalizeRepoPath(line.trim());
      if (normalized) files.add(normalized);
    }
  }
  return [...files].sort();
}

function normalizeRepoPath(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^["'`]+|["'`,;:]+$/g, "");
  text = text.replace(/^\(?/, "").replace(/\)?$/, "");
  text = text.replace(/^(?:a|b)\//, "");
  // Strip the harness-repo cwd prefix AND (cross-repo) the delivery-repo prefix,
  // so an absolute workflowhub path resolves to a repo-relative path instead of
  // being dropped by the trailing startsWith("/") guard.
  for (const root of [process.cwd(), DELIVERY_REPO].filter(Boolean)) {
    const r = String(root).replace(/\/+$/, "");
    if (text.startsWith(`${r}/`)) { text = text.slice(r.length + 1); break; }
  }
  text = text.replace(/^\.\//, "");
  if (!text || text.includes("://") || text.startsWith("/")) return "";
  if (!/[/.]/.test(text)) return "";
  return text;
}

function declaredPhaseFiles(originalPrompt) {
  const filesSection = section(originalPrompt, /^### Files\b/i, 3000)
    || grepLines(originalPrompt, [/packages\/core\/agenthub\//, /apply\/phase-\d+\.md/], 80);
  const files = new Set();
  for (const line of filesSection.split(/\r?\n/)) {
    const matches = line.match(/(?:`[^`]+`|(?:[./A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+)/g) || [];
    for (const raw of matches) {
      const normalized = normalizeRepoPath(raw.replace(/^`|`$/g, ""));
      if (normalized) files.add(normalized);
    }
  }
  return [...files].sort();
}

function classifyChangedFiles(originalPrompt) {
  const declared = new Set(declaredPhaseFiles(originalPrompt));
  const files = changedFiles(originalPrompt);
  const reviewDispatchInfra = [
    /^packages\/core\/agenthub\/skills\/3rd-review\//,
    /^packages\/core\/agenthub\/harness\/review-dispatch-adapter\.sh$/,
    /^packages\/core\/agenthub\/harness\/delegated-review\.test\.ts$/,
    /^packages\/core\/agenthub\/scripts\/delegated-metrics\./,
    /^packages\/core\/agenthub\/schemas\/verdict\.schema\.json$/,
    /^packages\/core\/agenthub\/skills\/3rd-review\/verifiers\/base-verifier\.md$/,
    /^packages\/core\/agenthub\/agenthub-contracts\.test\.ts$/,
  ];
  const storageLayoutPrecondition = [
    /^packages\/core\/agenthub\/bin\/path-helper\.ts$/,
    /^packages\/core\/agenthub\/host\/storage-layout\./,
    /^packages\/core\/agenthub\/host\/phase0-verify\.test\.ts$/,
    /^packages\/core\/agenthub\/host\/storage-layout\.test\.ts$/,
  ];
  const phaseTestSupport = [
    /^packages\/core\/agenthub\/host\/gate\.test\.ts$/,
    /^packages\/core\/agenthub\/host\/workflow-gate\.ts$/,
    /^packages\/core\/agenthub\/harness\/verify-phase-0\.sh$/,
  ];
  const lines = files.map((file) => {
    let classification = "outside-declared-files";
    if (declared.has(file)) classification = "declared-phase-file";
    else if (reviewDispatchInfra.some((pattern) => pattern.test(file))) classification = "precondition-fix:review-dispatch-infrastructure";
    else if (storageLayoutPrecondition.some((pattern) => pattern.test(file))) classification = "precondition-fix:storage-layout";
    else if (phaseTestSupport.some((pattern) => pattern.test(file))) classification = "phase-test-support";
    else if (/^apply\/phase-\d+\.md$/.test(file) || /^apply\/evidence\//.test(file)) classification = "phase-evidence-or-notes";
    return `- ${file} — ${classification}`;
  });
  return [
    "## Precomputed Changed File Classification",
    `Declared phase files: ${declared.size ? [...declared].join(", ") : "(none detected)"}`,
    "Changed files:",
    lines.length ? lines.join("\n") : "(none detected)",
  ].join("\n");
}

function precomputedMechanicalGrep(originalPrompt) {
  const files = changedFiles(originalPrompt).filter((file) => /\.(ts|tsx|sh|md)$/.test(file));
  const patterns = [
    { name: "provider_name", regex: /\b(codex|Claude|claude|openai|gpt)\b/i },
    { name: "forbidden_phrasing", regex: /\b(let me|I'll|we should|you're absolutely right)\b/i },
    { name: "stale_todo", regex: /\b(TODO:|FIXME:)\b/ },
    { name: "set_u_array", regex: /\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}/ },
  ];
  const allowlistReason = (file, line, patternName) => {
    if (patternName === "provider_name") {
      if (/packages\/core\/agenthub\/harness\/review-dispatch-adapter\.sh$/.test(file)) return "allowed: provider-specific adapter implementation";
      if (/packages\/core\/agenthub\/skills\/3rd-review\/scripts\//.test(file)) return "allowed: runtime metadata/config script";
      if (/packages\/core\/agenthub\/skills\/3rd-review\/dispatch-name-scan\.test\.ts$/.test(file)) return "allowed: provider-name scanner test fixture";
      if (/packages\/core\/agenthub\/skills\/3rd-review\/SKILL\.md$/.test(file)) {
        if (/codex exec|codex login|codex --version|command codex|@openai\/codex|~\/\.codex|\.codex\/|extract-codex-meta|Codex CLI/i.test(line)) {
          return "allowed: CLI invocation/path/package/script filename";
        }
        if (/CLAUDE(?:_SKILLS|\.md)|\.claude\/skills|OpenAI structured outputs|Codex 原始会话|ChatGPT login|GPT-?5(?:\.\d+)?|_codexMeta|tokenScope|subreviewerRuntimeReports/i.test(line)) {
          return "allowed: runtime/tooling compatibility documentation";
        }
      }
      if (/packages\/core\/agenthub\/workflows\/vibecoding\/stages\/.*\.md$/.test(file) && /CLAUDE\.md|packages\/core\/agenthub\/CLAUDE\.md/.test(line)) {
        return "allowed: standards-source documentation reference";
      }
      if (/packages\/core\/agenthub\/agenthub-contracts\.test\.ts$/.test(file)) return "allowed: compatibility/provider fixture test";
    }
    if (patternName === "set_u_array" && /packages\/core\/agenthub\/harness\/review-dispatch-adapter\.sh$/.test(file)) {
      const name = (line.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}/) || [])[1];
      if (["RESOLVE_ARGS", "PRECHECK_ARGS", "PERSIST_ARGS", "CODEX_OPTS"].includes(name)) {
        return "allowed: initialized local argument array expansion";
      }
    }
    return "";
  };
  const severityFor = (file, line, patternName) => {
    const allow = allowlistReason(file, line, patternName);
    if (allow) return { severity: "allowed", reason: allow };
    if (patternName === "provider_name" && /\.(md)$/.test(file)) return { severity: "risk", reason: "provider name in markdown/prose outside allowlist" };
    if (patternName === "set_u_array") return { severity: "warning", reason: "possible set -u unsafe array expansion" };
    if (patternName === "forbidden_phrasing") return { severity: "risk", reason: "agent-facing phrasing may be non-neutral" };
    return { severity: "info", reason: "mechanical match for final verifier awareness" };
  };
  const matches = [];
  for (const file of files.slice(0, 120)) {
    if (!fs.existsSync(file)) continue;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile() || stat.size > 250000) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
          const classified = severityFor(file, line, pattern.name);
          matches.push(`${file}:${index + 1}:${pattern.name}:${classified.severity}: ${classified.reason}: ${line.trim().slice(0, 220)}`);
          break;
        }
      }
    });
  }
  return [
    "## Precomputed Mechanical Grep Input",
    `Files scanned: ${files.length}`,
    `Patterns: ${patterns.map((p) => p.name).join(", ")}`,
    "Severity rules: allowed matches are facts only and MUST NOT become riskFlags; warning/risk matches may become riskFlags; info matches should usually remain facts.",
    "Matches:",
    matches.length ? matches.slice(0, 300).join("\n") : "(none)",
  ].join("\n");
}

function promptEvidencePaths(originalPrompt) {
  const paths = new Set();
  const regex = /apply\/evidence\/[A-Za-z0-9._/-]+/g;
  let match;
  while ((match = regex.exec(originalPrompt)) !== null) {
    paths.add(match[0]);
  }
  return [...paths].sort();
}

function scanEvidenceDir(rootDir, sourceRoot, phaseNumber) {
  if (!rootDir) return [];
  const evidenceDir = path.join(rootDir, "apply", "evidence");
  if (!fs.existsSync(evidenceDir)) return [];
  let entries = [];
  try { entries = fs.readdirSync(evidenceDir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    if (phaseNumber && !entry.name.startsWith(`phase-${phaseNumber}-`)) return [];
    const relPath = path.posix.join("apply", "evidence", entry.name);
    return [{
      path: relPath,
      absPath: path.join(evidenceDir, entry.name),
      sourceRoot,
    }];
  });
}

function evidencePathCandidates(originalPrompt, taskDir, repoRoot, phaseNumber) {
  const candidates = [];
  const seen = new Set();
  const add = (relPath, absPath, sourceRoot) => {
    if (!relPath || !absPath) return;
    const key = `${sourceRoot}:${relPath}:${absPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: relPath, absPath, sourceRoot });
  };

  for (const relPath of promptEvidencePaths(originalPrompt)) {
    const sourceRoot = path.isAbsolute(relPath) ? "prompt:absolute" : "prompt";
    const promptAbs = path.isAbsolute(relPath) ? relPath : path.resolve(repoRoot || process.cwd(), relPath);
    add(relPath, promptAbs, sourceRoot);
    if (taskDir && !path.isAbsolute(relPath)) {
      add(relPath, path.resolve(taskDir, relPath), "taskDir");
    }
  }

  for (const item of scanEvidenceDir(taskDir, "taskDir", phaseNumber)) {
    add(item.path, item.absPath, item.sourceRoot);
  }
  for (const item of scanEvidenceDir(repoRoot, "repoRoot", phaseNumber)) {
    add(item.path, item.absPath, item.sourceRoot);
  }

  return candidates.sort((a, b) => `${a.path}:${a.sourceRoot}`.localeCompare(`${b.path}:${b.sourceRoot}`));
}

function evidenceRootMismatches(evidenceMeta) {
  const byPath = new Map();
  for (const entry of evidenceMeta) {
    if (!entry.exists || !entry.gitHash) continue;
    const list = byPath.get(entry.path) || [];
    list.push(entry);
    byPath.set(entry.path, list);
  }
  const mismatches = [];
  for (const [relPath, entries] of byPath) {
    const hashes = new Map(entries.map((entry) => [entry.sourceRoot, entry.gitHash]));
    if (new Set(hashes.values()).size <= 1) continue;
    mismatches.push({
      path: relPath,
      detail: `evidence hash differs across roots: ${entries.map((entry) => `${entry.sourceRoot}=${entry.gitHash}`).join(", ")}`,
    });
  }
  return mismatches;
}

function extractPromptField(originalPrompt, fieldName) {
  const re = new RegExp(`^${fieldName}:\\s*(\\S+)`, "im");
  const match = originalPrompt.match(re);
  return match ? match[1].trim() : null;
}

function parseTaskId(taskDir) {
  if (!taskDir) return "";
  const agentsFile = path.join(taskDir, "AGENTS.md");
  const stateFile = path.join(taskDir, "state.json");
  const fromAgents = readIfExists(agentsFile).match(/^\s*task_id:\s*(\S+)/m);
  if (fromAgents) return fromAgents[1];
  try {
    const state = JSON.parse(readIfExists(stateFile) || "{}");
    return typeof state.taskId === "string" ? state.taskId : "";
  } catch {
    return "";
  }
}

function resolveTasksFile(taskDir, repoRoot) {
  const taskId = parseTaskId(taskDir);
  if (!taskId) return "";
  const primary = path.join(repoRoot, "specs", taskId, "tasks.md");
  if (fs.existsSync(primary)) return primary;
  const archiveRoot = path.join(repoRoot, "specs", "archive");
  if (!fs.existsSync(archiveRoot)) return "";
  const stack = [archiveRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === "tasks.md" && full.includes(taskId)) return full;
    }
  }
  return "";
}

function extractPhaseVerifyCommands(tasksFile, phaseNumber) {
  if (!tasksFile || !phaseNumber || !fs.existsSync(tasksFile)) return [];
  const text = fs.readFileSync(tasksFile, "utf8");
  const phaseBlock = headingBlock(text, new RegExp(`^##\\s+Phase\\s+${String(phaseNumber)}(?:\\b|\\s*[:：-])`, "i"), 16000);
  if (!phaseBlock) return [];
  const verifyBlock = headingBlock(phaseBlock, /^###\s+Verify\b/i, 8000);
  if (!verifyBlock) return [];
  const commands = [];
  const seen = new Set();
  const patterns = [
    /`([^`\n]+)`/g,
    /(?:^|\s)(pnpm|npm|yarn|bash|node|git)\s+([^\n]+)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(verifyBlock)) !== null) {
      const command = pattern === patterns[0]
        ? match[1].trim()
        : `${match[1]} ${match[2].trim()}`.replace(/\s+→.*$/, "").trim();
      if (!command || seen.has(command)) continue;
      seen.add(command);
      commands.push(command);
    }
  }
  return commands.slice(0, 10);
}

function observedExitCodeFor(command, evidenceMeta) {
  for (const entry of evidenceMeta) {
    if (!entry?.jsonFields || typeof entry.jsonFields.command !== "string") continue;
    const evidenceCommand = entry.jsonFields.command.trim();
    if (evidenceCommand === command.trim()) return entry.jsonFields.exit_code ?? null;
  }
  return null;
}

function inferReviewRequestIdFromJournal(taskDir, checkpoint, round) {
  // Prefer source-derived layout (layout-version.json marker)
  if (!taskDir || !checkpoint) return null;
  const layoutMarker = path.join(taskDir, ".machine", "layout-version.json");
  const journalPath = fs.existsSync(layoutMarker)
    ? path.join(taskDir, ".machine", "source", "journal.jsonl")
    : path.join(taskDir, "journal.jsonl");
  if (!fs.existsSync(journalPath)) return null;
  try {
    const lines = fs.readFileSync(journalPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event !== "checkpoint_request") continue;
      if (event.checkpoint !== checkpoint) continue;
      if (round && String(event.round) !== String(round)) continue;
      if (typeof event.requestId === "string" && event.requestId.trim()) {
        return event.requestId.trim();
      }
    }
  } catch {
    // Journal read failure is non-fatal
  }
  return null;
}

function hostVerifiedFacts(originalPrompt) {
  const taskDir = argValue("task-dir") || extractPromptField(originalPrompt, "taskDir") || null;
  const repoRoot = extractPromptField(originalPrompt, "repoRoot")
    || safeExec("git rev-parse --show-toplevel")
    || process.cwd();
  const checkpoint = extractPromptField(originalPrompt, "checkpoint");
  const round = extractPromptField(originalPrompt, "round");
  // If prompt lacks reviewRequestId, attempt to infer it from the source-derived task journal
  const reviewRequestIdFromPrompt = extractPromptField(originalPrompt, "reviewRequestId");
  const reviewRequestId = reviewRequestIdFromPrompt
    || inferReviewRequestIdFromJournal(taskDir, checkpoint, round);
  const phaseFromCheckpoint = checkpoint && checkpoint.match(/phase-(\d+)/i);
  const phaseNumber = phaseFromCheckpoint ? Number(phaseFromCheckpoint[1]) : null;
  const currentHead = safeExec(`git -C ${JSON.stringify(repoRoot)} rev-parse HEAD`);
  const collectedAt = new Date().toISOString();
  const paths = evidencePathCandidates(originalPrompt, taskDir, repoRoot, phaseNumber);

  // Collect evidence metadata
  const evidenceMeta = [];
  for (const candidate of paths.slice(0, 120)) {
    const file = candidate.absPath;
    const entry = {
      path: candidate.path,
      absPath: file,
      sourceRoot: candidate.sourceRoot,
      exists: fs.existsSync(file),
      size: null,
      gitHash: null,
      jsonFields: null,
      mismatch: false,
    };
    if (entry.exists) {
      entry.size = fs.statSync(file).size;
      entry.gitHash = safeExec(`git -C ${JSON.stringify(repoRoot)} hash-object ${JSON.stringify(file)}`) || null;
    }
    if (entry.exists && /\.json$/.test(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        entry.jsonFields = {
          cwd: data.cwd || null,
          git_sha: data.git_sha || data.gitSha || null,
          command: data.command || null,
          exit_code: data.exit_code,
          timestamp: data.timestamp || null,
          phase: data.phase,
          mode: data.mode,
        };
        // git_sha is evidence provenance metadata only.
        // freshness is determined by file hash / journal hash comparison.
        // DO NOT compare git_sha against current HEAD:
        //   TDD workflow captures evidence at intermediate commits;
        //   subsequent bugfix commits naturally change HEAD.
        //   Comparing git_sha to HEAD produces false mismatches.
        if (entry.jsonFields.cwd && entry.jsonFields.cwd !== repoRoot) {
          entry.mismatch = true;
          entry.mismatchDetail = `evidence cwd=${entry.jsonFields.cwd} != repoRoot=${repoRoot}`;
        }
      } catch {
        entry.jsonFields = { parseError: true };
      }
    }
    evidenceMeta.push(entry);
  }

  // Collect mismatched evidence for riskFlags
  const mismatched = [
    ...evidenceMeta.filter((e) => e.mismatch),
    ...evidenceRootMismatches(evidenceMeta).map((item) => ({
      path: item.path,
      mismatch: true,
      mismatchDetail: item.detail,
    })),
  ];
  const tasksFile = taskDir ? resolveTasksFile(taskDir, repoRoot) : "";
  const verifyCommands = extractPhaseVerifyCommands(tasksFile, phaseNumber).map((command) => ({
    command,
    source: tasksFile ? `${tasksFile}#Verify` : "tasks.md Verify",
    observedExitCode: observedExitCodeFor(command, evidenceMeta),
  }));

  const facts = {
    source: "host-verified-facts",
    collectedAt,
    repoRoot,
    taskDir,
    gitHEAD: currentHead,
    reviewRequestId,
    checkpoint,
    round,
    fourTuple: {
      repoRoot,
      taskDir,
      gitHEAD: currentHead,
      reviewRequestId,
    },
    sources: {
      repoRoot: "prompt:repoRoot | git rev-parse --show-toplevel",
      taskDir: taskDir ? "adapter --task-dir | prompt:taskDir" : null,
      gitHEAD: "git rev-parse HEAD",
      evidenceMeta: "prompt paths + taskDir/repoRoot apply/evidence scan + git hash-object",
      verifyCommands: tasksFile ? `${tasksFile}#Verify` : null,
    },
    evidenceMeta,
    evidenceMismatches: mismatched.map((e) => ({
      path: e.path,
      detail: e.mismatchDetail,
    })),
    verifyCommands,
  };

  // Build structured JSON block
  const jsonBlock = "```json\n" + JSON.stringify(facts, null, 2) + "\n```";

  // Also keep the human-readable lines for backward compatibility
  const mismatchLines = mismatched.length
    ? [`EVIDENCE MISMATCH DETECTED (${mismatched.length} files):`, ...mismatched.map((e) => `  - ${e.path}: ${e.mismatchDetail}`), ""]
    : ["Evidence provenance matches current worktree — no mismatches",""];

  // Compute journal pointer for inferred reviewRequestId provenance
  const journalPointerLine = (!reviewRequestIdFromPrompt && reviewRequestId && taskDir)
    ? (() => {
        const layoutMarker = path.join(taskDir, ".machine", "layout-version.json");
        const journalPath = fs.existsSync(layoutMarker)
          ? path.join(taskDir, ".machine", "source", "journal.jsonl")
          : path.join(taskDir, "journal.jsonl");
        return `- reviewRequestId inferred from: ${journalPath}`;
      })()
    : null;

  const textLines = [
    "## Host-Verified Facts (precomputed by host — reviewer trusts these, does not re-run commands)",
    `- repoRoot: ${repoRoot}`,
    `- taskDir: ${taskDir || "(unavailable)"}`,
    `- git HEAD: ${currentHead || "(unavailable)"}`,
    `- reviewRequestId: ${reviewRequestId || "(unavailable)"}`,
    ...(journalPointerLine ? [journalPointerLine] : []),
    `- collectedAt: ${collectedAt}`,
    `- Evidence files: ${evidenceMeta.length}`,
    `- Verify commands captured: ${verifyCommands.length}`,
    ...mismatchLines,
    "### Structured Host-Verified Facts",
    jsonBlock,
    "### Evidence File Details",
  ];

  return { text: textLines.join("\n"), facts, mismatched };
}

function precomputedEvidence(originalPrompt) {
  const hv = hostVerifiedFacts(originalPrompt);
  const lines = [
    hv.text,
  ];
  // Legacy details for human readability
  for (const entry of hv.facts.evidenceMeta.slice(0, 120)) {
    const file = entry.absPath;
    const exists = Boolean(entry.exists);
    const size = exists ? entry.size : null;
    const gitHash = entry.gitHash || "";
    let jsonFields = "";
    if (exists && /\.json$/.test(file)) {
      const jf = entry.jsonFields;
      if (jf && !jf.parseError) {
        jsonFields = ` json.cwd=${jf.cwd || ""} json.git_sha=${jf.git_sha || ""} json.command=${jf.command || ""}`;
      } else {
        jsonFields = " json.parse=failed";
      }
    }
    lines.push(`- ${entry.sourceRoot}:${entry.path}: exists=${exists} size=${size ?? "missing"} git_hash=${gitHash || "(unavailable)"}${jsonFields}`);
  }
  lines.push("Embedded phase evidence lines:");
  lines.push(grepLines(originalPrompt, [/apply\/evidence\//, /\bRED\b/, /\bGREEN\b/, /hash:/, /git_sha/, /cwd/], 120) || "(none)");
  return lines.join("\n");
}

function planTracebilitySourceSlice(originalPrompt) {
  // Extract tasks.md files from source manifest and format as labeled sections for the plan-traceability lens.
  const manifestFiles = extractSourceManifestFiles(originalPrompt);
  const tasksFiles = manifestFiles.filter((f) => /\btasks\.md$/.test(f));
  const planFiles = manifestFiles.filter((f) => /\bplan\.md$/.test(f));
  const lines = [
    "## Plan Traceability: Source Slice",
    "",
    "Authoritative sources for this lens (from Source Manifest):",
  ];
  for (const f of tasksFiles) {
    lines.push(`## Tasks: ${f}`);
    lines.push(`(read ${f} to verify FR-to-task mapping and verify steps)`);
    lines.push("");
  }
  for (const f of planFiles) {
    lines.push(`## Plan: ${f}`);
    lines.push(`(read ${f} to verify phase structure and acceptance criteria coverage)`);
    lines.push("");
  }
  lines.push(
    "## Traceability Instructions",
    "",
    "- Line format: NNNN: source line (quote verbatim from tasks.md when referencing task rows)",
    "- Check phase-local test-first ordering only from quoted task rows (do not infer from description alone)",
    "- Flag FRs that lack an explicit Verify step with observable output",
    "- Flag FRs whose verify step is prose-only (no command or artifact reference)",
  );
  return lines.join("\n");
}

function planRequiredSkillContext(originalPrompt) {
  // Emit build-plan-reviewer-specific required skill contract reference and skill list.
  const checkpoint = extractPromptField(originalPrompt, "checkpoint") || "";
  const cp = checkpoint.toLowerCase();
  if (!cp.startsWith("build-plan") && !cp.startsWith("plan")) return "";
  const contractPath = "verifiers/vibecoding/build-plan-reviewer-contract.md";
  const planContract = readIfExists(repoFile(contractPath));
  const contractChunk = planContract
    ? bounded(planContract, 6000)
    : "(build-plan-reviewer-contract.md unavailable)";
  return [
    `## Plan Review Required Skill Contract`,
    `authoritativeContract: ${contractPath}`,
    "",
    "Required skills expected for this checkpoint: speckit-analyze, plan-eng-review, review",
    "",
    contractChunk,
  ].join("\n");
}

// ── FR-REVSUB-003 (T013): over-size visible warning threshold ──
// When the full diff fed to direction lenses exceeds this character count, emit a
// machine-detectable over-size warning. The content is NOT truncated (FR-REVSUB-001/002
// mandate full feed to catch back-half violations). The warning is a diagnostic signal
// for cost/latency awareness and enables downstream tooling to detect oversized reviews.
// Threshold is intentionally separate from any truncation limit so they can be tuned
// independently. See: spec FR-REVSUB-003.
const SUBREVIEWER_WARN_CHARS = 80000;

function lensSlice(lens, originalPrompt, promptSpec = null) {
  const common = [
    section(originalPrompt, /^## Runtime Preferences\b/i, 2000),
    grepLines(originalPrompt, [/^reviewRequestId:/i, /^checkpoint:/i, /^round:/i, /^review kind:/i], 20),
    section(originalPrompt, /^## Source Manifest\b/i, 6000),
    section(originalPrompt, /^## Required Read Set\b/i, 6000),
  ].filter(Boolean);

  // FR-REVSUB-001/002 (T012): feed the FULL Delta Package section to direction lenses
  // with NO character cap. The prior section(..., 16000) truncation silently dropped
  // the back half of large diffs, causing scope-boundary and source-manifest lenses to
  // miss out-of-allowlist edits that appeared past char 16000. The full-feed variant
  // uses extractSection() (no maxChars) instead of bounded section(). grepLines fallback
  // is kept for prompts that have no ## Delta Package heading.
  // FR-REVSUB-003 (T013): if the full diff content exceeds SUBREVIEWER_WARN_CHARS, prepend
  // a machine-detectable over-size warning. Content stays full — no truncation added.
  const rawDiffBody = extractSection(originalPrompt, /^## Delta Package\b/i);
  let diff;
  if (rawDiffBody) {
    const fullDiff = "## Delta Package\n\n" + rawDiffBody;
    if (fullDiff.length > SUBREVIEWER_WARN_CHARS) {
      diff = `[oversized-diff-warning: diff length ${fullDiff.length} chars exceeds SUBREVIEWER_WARN_CHARS=${SUBREVIEWER_WARN_CHARS}; content is full (not truncated) — review may be slower/costlier]\n\n` + fullDiff;
    } else {
      diff = fullDiff;
    }
  } else {
    diff = grepLines(originalPrompt, [/^diff --git /, /^\+\+\+ /, /^--- /, /^@@ /], 400);
  }
  const standards = section(originalPrompt, /^## Standards Sources\b/i, 6000);
  const design = section(originalPrompt, /^## Inline Package\b/i, 10000)
    || section(originalPrompt, /^## Design Sources\b/i, 10000);

  // RD-6 (T009): the machine-generated Current Worktree Inventory (from build-review-package)
  // is the authoritative changed-file inventory. Feed the whole inventory section into the
  // source-manifest lens slice so it audits real git state, not the diff-derived approximation.
  // Use extractSection (stops at <= startLevel) instead of section (stops at any #{1,3}): the
  // inventory body contains `### Inventory Stats` / `### Structured Inventory` subheadings, which
  // section() would truncate at — starving the lens of the actual file list. Re-prepend the
  // heading since extractSection drops the heading line.
  const inventoryBody = extractSection(originalPrompt, /^##\s+Current Worktree Inventory\b/i);
  const machineInventory = inventoryBody
    ? bounded("## Current Worktree Inventory\n\n" + inventoryBody, 8000)
    : "";
  const byLens = {
    "source-manifest-auditor": [contractContext("source-manifest"), machineInventory, classifyChangedFiles(originalPrompt), design, diff, grepLines(originalPrompt, [/tasks\.md/i, /Files/i, /source manifest/i], 200)],
    "required-skill-auditor": [contractContext("required-skill"), planRequiredSkillContext(originalPrompt), standards, grepLines(originalPrompt, [/required skill/i, /Mandatory Skills/i, /skillResults/i], 240)],
    "scope-boundary-auditor": [contractContext("scope-boundary"), standards, diff, grepLines(originalPrompt, [/forbidden/i, /boundary/i, /scope/i, /core files/i], 240)],
    "evidence-freshness-auditor": [precomputedEvidence(originalPrompt)],
    "mechanical-grep-auditor": [precomputedMechanicalGrep(originalPrompt)],
    "plan-traceability-auditor": [planTracebilitySourceSlice(originalPrompt), grepLines(originalPrompt, [/\bFR-/, /\bT\d{3,4}\b/, /Verify/, /Success Criteria/, /Depends On/], 400)],
    // Threat-modeling lens: feed the design spec content so the auditor can
    // detect adversarial defects in forgery-bypass / proof-independence / schema-drift.
    "threat-modeling-auditor": [design, standards, grepLines(originalPrompt, [/forgery/i, /bypass/i, /proof/i, /schema/i, /AJV/i, /造假/i, /独立/i, /验证/i, /开关/i, /时机/i, /裁决/i], 400)],
  };
  const dynamicHintText = promptSpec
    ? grepLines(originalPrompt, promptSpec.sliceHints.map((hint) => new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")), 360)
    : "";
  const dynamicSlice = promptSpec
    ? [design, standards, diff, dynamicHintText].filter(Boolean)
    : [diff];
  return [...common, ...(byLens[lens] || dynamicSlice)]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function subreviewerInstructions(lens) {
  return `Return JSON only with this exact shape:
{
  "subreviewerRequestId": "<id>",
  "lens": "${lens}",
  "status": "ok|risk|fail",
  "facts": ["specific fact with file/path/line when applicable"],
  "riskFlags": [{"type":"other","target":"path-or-scope","description":"specific risk"}],
  "candidateFindings": [],
  "coverageProof": [{"file":"path-or-review-slice","ranges":["slice"],"coverageMetric":"structural","assertionType":"${lens}","result":"ok|risk|fail","digest":"short-digest"}],
  "mustEscalateToFinal": false
}

Rules:
- Do not output pass/revise_required/escalate_to_human.
- Use ONLY the Lens Source Slice and precomputed inputs below. Do not run shell commands, do not read repository files, and do not inspect chat history.
- Do not use status=unavailable.
- If the slice lacks enough material, use status=risk, add one fact describing the missing input, and add one riskFlag explaining what Final Verifier must inspect.
- Empty facts with empty riskFlags is invalid.
- Missing coverageProof is invalid.
- Keep facts concrete and brief.`;
}

function lensTextFromPromptSpec(lens, promptSpec) {
  if (!promptSpec) return "";
  const checks = promptSpec.checks.length
    ? promptSpec.checks.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. Inspect only the supplied Lens Source Slice.\n2. Report concrete facts, risks, and candidate findings for this lens.";
  const hints = promptSpec.sliceHints.length
    ? promptSpec.sliceHints.map((item) => `- ${item}`).join("\n")
    : "- Use the common review package slice.";
  return `# ${lens} — Dynamic Lens Template

## Role

${promptSpec.role || "Perform the requested delegated review lens for this checkpoint."}

## Checks

${checks}

## Slice Hints

${hints}

## Forbidden

- Do NOT output a final verdict.
- Do NOT modify files.
- Do NOT inspect chat history.
- Do NOT turn contract-external concerns into blocking findings.`;
}

function invalidReportReason(report) {
  if (!report || typeof report !== "object") return "missing report";
  // A lens may legitimately determine it does not apply to this checkpoint (e.g.
  // evidence-freshness on a design-review with no RED/GREEN evidence). Per the lens
  // contracts (subreviewers/*.md check 0), that is reported as status=not_applicable
  // with no facts/coverageProof — a valid empty report, not an invalid one.
  if (report.status === "not_applicable" || report.status === "skipped") return "";
  if (report.status === "unavailable") return "status unavailable";
  const hasFacts = Array.isArray(report.facts) && report.facts.length > 0;
  const hasRisks = Array.isArray(report.riskFlags) && report.riskFlags.length > 0;
  const hasCandidates = Array.isArray(report.candidateFindings) && report.candidateFindings.length > 0;
  const hasCoverage = Array.isArray(report.coverageProof) && report.coverageProof.length > 0;
  if (!hasFacts && !hasRisks && !hasCandidates) return "empty facts/riskFlags/candidateFindings";
  if (!hasCoverage) return "missing coverageProof";
  return "";
}

function invalidRawReason(raw) {
  if (raw && typeof raw === "object" && raw.verdict && !raw.status) {
    return "returned final reviewer verdict schema instead of subreviewer report schema";
  }
  return "";
}

function writeLensPrompt({
  promptFile,
  lens,
  lensText,
  subreviewerRequestId,
  checkpointId,
  round,
  slice,
  retryNote = "",
}) {
  fs.writeFileSync(promptFile, [
    "## Reviewer-Dispatch Delegated Precheck Lens",
    `subreviewerRequestId: ${subreviewerRequestId}`,
    `checkpoint: ${checkpointId || ""}`,
    `round: ${round || "1"}`,
    `lens: ${lens}`,
    "",
    "Execution constraint: lens checks describe what to verify, but this subreviewer must use only the Lens Source Slice and precomputed inputs in this prompt.",
    "",
    lensText,
    "",
    subreviewerInstructions(lens),
    retryNote ? `\n## Previous Invalid Output\n${retryNote}` : "",
    "",
    "## Lens Source Slice",
    slice || "(no source slice available)",
  ].join("\n"));
}

async function invokeSubreviewer({ adapter, promptFile, resultFile, checkpointId, round, configFile }) {
  const args = [
    adapter,
    "exec",
    "--role=subreviewer",
    `--prompt-file=${promptFile}`,
    `--result-file=${resultFile}`,
    `--checkpoint-id=${checkpointId || ""}`,
    `--round=${round || "1"}`,
  ];
  if (configFile) args.push(`--config-file=${configFile}`);

  const started = Date.now();
  const child = spawn("bash", args, {
    env: { ...process.env, REVIEW_DELEGATED_PRECHECK: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const code = await new Promise((resolve) => child.on("close", resolve));
  const elapsedSec = Math.round((Date.now() - started) / 1000);
  let raw = {};
  let error = "";
  if (code !== 0) {
    error = stderr.trim() || `subreviewer exited ${code}`;
  } else {
    try {
      raw = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    } catch (err) {
      error = `invalid JSON result: ${err.message}`;
    }
  }
  return { raw, error, elapsedSec };
}

async function runLens({ lens, originalPrompt, lensText, promptSpec, adapter, checkpointId, round, configFile, workDir }) {
  const promptFile = path.join(workDir, `${lens}.prompt.md`);
  const resultFile = path.join(workDir, `${lens}.result.json`);
  const subreviewerRequestId = `${checkpointId || "review"}.${round || "1"}.${lens}`;
  const slice = lensSlice(lens, originalPrompt, promptSpec);

  writeLensPrompt({
    promptFile,
    lens,
    lensText,
    subreviewerRequestId,
    checkpointId,
    round,
    slice,
  });

  const { raw, error, elapsedSec } = await invokeSubreviewer({
    adapter,
    promptFile,
    resultFile,
    checkpointId,
    round,
    configFile,
  });
  const report = normalizeReport(lens, raw, error);
  const invalidReason = error || invalidRawReason(raw) || invalidReportReason(report);
  const runtime = runtimeReport(lens, raw, resultFile);
  if (runtime.elapsedSec === undefined) runtime.elapsedSec = elapsedSec;
  return {
    lens,
    report,
    runtime,
    resultFile,
    promptFile,
    error: invalidReason ? `${lens} produced invalid report: ${invalidReason}` : null,
  };
}

async function main() {
  const promptFile = argValue("prompt-file");
  const outFile = argValue("out-file");
  const checkpointId = argValue("checkpoint-id");
  const round = argValue("round") || "1";
  const adapter = argValue("adapter");
  const configFile = argValue("config-file");
  // Cross-repo apply: delivery repo to scope changed-file detection / path
  // normalization to the EXTERNAL reviewed repo (empty → harness-repo cwd).
  DELIVERY_REPO = argValue("delivery-repo") || null;
  const skillDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const subreviewerDir = path.join(skillDir, "subreviewers");

  if (!promptFile || !outFile || !adapter) {
    console.error("ERROR: --prompt-file, --out-file and --adapter are required");
    process.exit(2);
  }

  const originalPrompt = fs.readFileSync(promptFile, "utf8");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-delegated-precheck-"));
  const resolvedPlan = resolveLensSpecs(configFile, checkpointId, originalPrompt);
  const lensSpecs = resolvedPlan.specs;
  const tasks = lensSpecs.map(({ name: lens, promptSpec }) => {
    const lensPath = path.join(subreviewerDir, `${lens}.md`);
    const lensText = promptSpec
      ? lensTextFromPromptSpec(lens, promptSpec)
      : fs.existsSync(lensPath)
        ? fs.readFileSync(lensPath, "utf8")
        : `# ${lens}\nLens file missing; report unavailable.`;
    return runLens({ lens, originalPrompt, lensText, promptSpec, adapter, checkpointId, round, configFile, workDir });
  });
  const results = await Promise.all(tasks);
  const reports = results.map((item) => item.report);
  const { bundle, finalFacingBundle } = buildBundle(reports, originalPrompt);
  const hv = hostVerifiedFacts(originalPrompt);
  // Inject evidence mismatches as topRisks in bundle
  if (hv.mismatched.length > 0) {
    bundle.topRisks = [
      ...(bundle.topRisks || []),
      ...hv.mismatched.map((e) => ({
        target: e.path,
        description: `Evidence provenance mismatch: ${e.mismatchDetail}. Host-Verified Facts show current repoRoot=${hv.facts.repoRoot} git HEAD=${hv.facts.gitHEAD}`,
        severity: "risk",
      })),
    ];
  }
  // precheckScriptSha256: hash of this script for traceability
  const precheckScriptSha256 = crypto.createHash("sha256")
    .update(fs.readFileSync(new URL(import.meta.url).pathname, "utf8"))
    .digest("hex");
  // lensPlanSha256: hash of the resolved lens plan
  const lensPlanSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(resolvedPlan.specs.map((s) => s.name)))
    .digest("hex");
  const runtimeFingerprint = {
    plannerRulesVersion: "strong-signal-v4",
    precheckScriptSha256,
    lensPlanSha256,
  };
  const output = {
    version: "1.0",
    mode: "delegated",
    lenses: lensSpecs.map((item) => item.name),
    plannerDecisions: resolvedPlan.decisions,
    runtimeFingerprint,
    fourTuple: {
      repoRoot: hv.facts.repoRoot,
      taskDir: hv.facts.taskDir,
      gitHEAD: hv.facts.gitHEAD,
      reviewRequestId: hv.facts.reviewRequestId,
      checkpoint: hv.facts.checkpoint,
      round: hv.facts.round,
    },
    hostVerifiedFacts: hv.facts,
    bundle,
    finalFacingBundle,
    reports: results.map(({ lens, report, resultFile, promptFile: lensPromptFile, error }) => {
      const promptSha256 = lensPromptFile && fs.existsSync(lensPromptFile)
        ? crypto.createHash("sha256").update(fs.readFileSync(lensPromptFile, "utf8")).digest("hex")
        : crypto.createHash("sha256").update(lens).digest("hex");
      return { lens, report, resultFile, promptFile: lensPromptFile, promptSha256, error };
    }),
    subreviewerRuntimeReports: results.map((item) => item.runtime),
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n");
  const failed = results.filter((item) => item.error);
  if (failed.length > 0) {
    console.error(`ERROR: delegated precheck subreviewer failure: ${failed.map((item) => item.lens).join(", ")}`);
    process.exit(2);
  }
}

// Guard: only run main() when executed as a CLI script, not when imported as a module
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main().catch((err) => {
    console.error(`ERROR: delegated precheck failed: ${err.stack || err.message}`);
    process.exit(2);
  });
}

// Minimal exports for characterization tests (T029a). Behavior is unchanged.
export { buildBundle, hostVerifiedFacts, precomputedEvidence, applyKnownFalsePositiveFilter, normalizeStatus, invalidReportReason };

// ── Test-only export: expose lensSlice for B3 falsifiability tests ──
// lensSlice is a private function used by subreviewers; exporting it directly for
// testing avoids needing a full subreviewer pipeline to assert on diff-feed content.
// Only the slice content is tested — not subreviewer execution or scoring.
export const lensSliceForTest = lensSlice;
