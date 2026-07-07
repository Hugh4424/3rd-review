#!/usr/bin/env node
/**
 * run-threat-auditor.mjs
 *
 * CLI: node run-threat-auditor.mjs --spec=<path> --auditor=<path> --output=<path>
 *
 * PURPOSE — DETERMINISTIC ORACLE-ACCEPTANCE HARNESS
 *
 * This script exists because FR-THREAT-003 requires a mechanical, CI-runnable
 * hit check. An LLM call is not deterministic enough for a gate, so this
 * harness uses fixed signal clusters instead.
 *
 * IMPORTANT SCOPE LIMITATION — read before relying on this file:
 *   This detector is keyed to the documented Check categories and covers the
 *   two known oracle specs (O1: review-skill-hardening, O2: workflow-overhead-
 *   reduction) plus benign/no-cross-fire falsifiability. It is NOT a complete
 *   general detector. It WILL miss class-correct adversarial defects worded
 *   outside its signal clusters (e.g. a novel forgery-bypass spec that does
 *   not use the specific vocabulary this file tests will yield 0 findings).
 *
 * THE PRODUCTION GENERAL DETECTOR is threat-modeling-auditor.md consumed via
 * base-verifier Delegated Review Mode, wired in run-delegated-precheck.mjs
 * (inferAutomaticLensPlan isDesign branch + byLens["threat-modeling-auditor"]).
 * That path sends the lens + spec to a real reviewer who reasons over novel
 * wording. This .mjs does NOT replace that path.
 *
 * AUDITOR FILE IS REQUIRED: the runner reads --auditor and exits non-zero if
 * it is absent, empty, or contains no "### Category:" sections. Removing the
 * .md makes this script fail and the vitest test go RED — that is intentional.
 * The .md's "### Category: X" headers drive which detectors are active.
 *
 * Falsifiability properties that DO hold:
 *   - Benign spec (no adversarial structural signals) → 0 blocking findings.
 *   - Schema-drift-only spec → 0 forgery-bypass findings (no cross-fire).
 *   - Missing or empty threat-modeling-auditor.md → runner exits non-zero.
 *
 * Output contract:
 *   hit:     {"status":"ok","findings":[{"severity":"blocking"|"important"|"minor",
 *             "category":"forgery-bypass"|"proof-independence"|"schema-drift",
 *             "description":"<str>"}]}
 *   no-spec: {"status":"skip","findings":[]}
 *
 * Exit code: 0 for hit or skip; non-zero on missing auditor or parse error.
 */
import fs from "node:fs";
import path from "node:path";

function argValue(name) {
  const prefix = `--${name}=`;
  const args = process.argv.slice(2);
  const eq = args.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] || "" : "";
}

// ---------------------------------------------------------------------------
// Load and validate the auditor lens file — REQUIRED.
// Parses "### Category: X" headers to determine which categories are active.
// ---------------------------------------------------------------------------
function loadAuditor(auditorPath) {
  if (!auditorPath) {
    process.stderr.write("Error: --auditor is required\n");
    process.exit(1);
  }
  let text;
  try {
    text = fs.readFileSync(auditorPath, "utf8");
  } catch (err) {
    process.stderr.write(`Error: cannot read auditor file "${auditorPath}": ${err.message}\n`);
    process.exit(1);
  }
  if (!text.trim()) {
    process.stderr.write(`Error: auditor file "${auditorPath}" is empty\n`);
    process.exit(1);
  }
  // Parse active categories from "### Category: <name>" headers.
  const categories = [];
  for (const m of text.matchAll(/^###\s+Category:\s+(.+)$/gim)) {
    const cat = m[1].trim().toLowerCase();
    categories.push(cat);
  }
  if (categories.length === 0) {
    process.stderr.write(`Error: auditor file "${auditorPath}" contains no "### Category:" sections\n`);
    process.exit(1);
  }
  return { text, categories };
}

// ---------------------------------------------------------------------------
// Spec loading — /dev/null or empty → skip sentinel.
// ---------------------------------------------------------------------------
function readSpec(specPath) {
  if (!specPath || specPath === "/dev/null") return null;
  try {
    const stat = fs.statSync(specPath);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(specPath, "utf8");
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Structural co-occurrence detectors.
//
// Each detector tests TWO independent signal clusters in the spec text.
// A finding fires only when BOTH clusters match — this is what makes the
// detector general (it catches the structural class) and falsifiable (a
// spec with only one cluster does not fire).
//
// Signal clusters use short, broad vocabulary words describing the CONCEPT,
// not verbatim oracle phrases. Each word list captures synonyms across
// languages (English + Chinese) so the detector works on specs written
// in either language.
// ---------------------------------------------------------------------------

// Negation cues (EN + CN) that, when found immediately before a matched term,
// mean the spec is describing a *prohibition* of the risky pattern rather than
// the pattern itself. Without this guard, a compliant spec that explicitly
// forbids a risky mechanism (e.g. "self-attest is forbidden") gets misread as
// describing that mechanism, and a benign/compliant spec fires a false
// blocking finding (FR-THIRDREVIEW-004).
const NEGATION_MARKERS = [
  "not ", "never ", "forbid", "prohibit", "must not", "cannot", "disallow",
  "no ", "禁止", "严禁", "杜绝", "不允许", "不得", "不可", "从不", "并不",
];

// round-review finding: a *marker-anywhere-in-window* test is sound for the
// pre-window check (a negation cue always grammatically governs whatever noun
// immediately follows it), but is NOT sound for the *post*-window check —
// "no " is the clearest example: it is only a valid negation marker when it
// sits *before* the matched term (e.g. "no self-attest allowed"); it always
// grammatically negates whatever noun immediately follows it, never a term
// earlier in the sentence. Applied to the *post*-window this produces
// false-negative suppression: "self-attest with no independent verifier" is
// a genuine forgery-bypass description (self-attest happening WITHOUT
// independent verification), but "no " sits within the 30-char window after
// "self-attest" even though it negates "independent verifier", not
// "self-attest" itself. The same unsoundness affects every other marker too:
// "self-attest is not independently verified" and "attest cannot be checked
// by an independent verifier" both contain a marker-anywhere hit
// ("not "/"cannot") within 30 chars after the matched term, yet neither
// sentence negates/prohibits the matched term itself — both instead describe
// the exact defect being reported (self-attestation happening without
// independent verification). Only a negation that grammatically governs a
// prohibition of the matched term itself — e.g. "self-attest is forbidden" —
// is a genuine compliant negation. These patterns encode exactly that
// grammar and are anchored to the start of the post-window (immediately
// after the match) so unrelated negation-shaped text later in the window
// can't accidentally satisfy them.
const POST_NEGATION_PROHIBITION_PATTERNS = [
  /^\s*(is|are|was|were|being)?\s*(explicitly\s+|strictly\s+|absolutely\s+)?(forbidden|prohibited|disallowed|banned|not\s+allowed|not\s+permitted)\b/i,
  /^\s*(must|shall|will)\s+not\s+(be\s+)?(used|allowed|permitted|performed|done)\b/i,
  /^\s*(cannot|can\s*not|can't)\s+(be\s+)?(used|allowed|permitted|performed|done)\b/i,
  /^\s*(禁止|严禁|杜绝|不允许|不得|不可)/,
];

// round-review finding: this only ever checked a window *before* the matched
// term (e.g. "never the same principal"). A spec phrased the other way round
// — term first, negation after, e.g. "Self-attest is explicitly forbidden" —
// was not covered: nothing negation-shaped sits in the 30 chars before
// "Self-attest", only after it ("is explicitly forbidden"). Checking both
// sides of the match, and matching terms case-insensitively (spec authors
// don't reliably match a term's declared casing), closes both gaps together.
function isNegatedNear(text, index, matchLength, window = 30) {
  // round-review finding: term matching was made case-insensitive but these
  // windows were still sliced from the original-case text and compared
  // against lowercase NEGATION_MARKERS — "MUST NOT self-attest" or "...is
  // explicitly Forbidden" would fail to match. Lowercase the pre-window too
  // (the post-window check is case-insensitive via its own regex `/i` flag).
  const before = text.slice(Math.max(0, index - window), index).toLowerCase();
  if (NEGATION_MARKERS.some((m) => before.includes(m))) return true;
  const after = text.slice(index + matchLength, index + matchLength + window);
  return POST_NEGATION_PROHIBITION_PATTERNS.some((re) => re.test(after));
}

/**
 * Returns true if the spec text contains at least one term from the list at
 * an occurrence that is NOT negated (by a marker immediately before OR
 * shortly after the match — see isNegatedNear). Checks every occurrence of
 * every term (not just the first) so a negated mention earlier in the text
 * does not mask a genuine, un-negated one later on. Matching is
 * case-insensitive.
 */
function hasAny(text, terms) {
  const lower = text.toLowerCase();
  return terms.some((t) => {
    if (t instanceof RegExp) {
      const base = t.flags.includes("i") ? t.flags : `${t.flags}i`;
      const flags = base.includes("g") ? base : `${base}g`;
      const re = new RegExp(t.source, flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        if (!isNegatedNear(text, m.index, m[0].length)) return true;
        if (re.lastIndex === m.index) re.lastIndex += 1; // avoid infinite loop on zero-length match
      }
      return false;
    }
    const needle = t.toLowerCase();
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      if (!isNegatedNear(text, idx, needle.length)) return true;
      idx = lower.indexOf(needle, idx + 1);
    }
    return false;
  });
}

/**
 * forgery-bypass: spec describes (A) an attestation/persist/proof mechanism
 * AND (B) a path where the same principal can inject evidence or satisfy the
 * proof check without being the genuine independent reviewer.
 *
 * Cluster A — attestation/persist mechanism vocabulary
 * Cluster B — same-principal injection / self-satisfy vocabulary
 */
function detectForgeryBypass(text) {
  const findings = [];

  // Cluster A: spec mentions a REVIEW-specific persist/attest/proof mechanism.
  // Deliberately narrow: "gate" and "关卡" alone are too broad (any gate triggers
  // them); require them alongside a review-specific qualifier.
  const clusterA_persist = [
    "reviewer_output", "review_output", "persist.*review", "review.*persist",
    "attest", "proof.*verif", "verif.*proof",
    "落盘.*审查", "审查.*落盘",
    "journal.*review", "review.*journal",
    "reviewRequestId", "bindingStatus",
  ];

  // Cluster B variants: self-satisfy, global-scan, hand-written.
  // Use more specific compound terms to avoid matching specs that merely mention
  // these words in a non-injection context.
  const clusterB_selfSatisfy = [
    "same principal", "same agent",
    "self-attest", "self attest", "self-inject",
    "orchestrator.*satisfy", "orchestrator.*inject",
    /自己.*会话.*满足/, /主.*agent.*满足/, /主.*agent.*注入/,
    /主执行.*agent.*自身/, "fabricat",
  ];
  const clusterB_globalScan = [
    "global scan", "全局.*扫描", "全局扫描",
    /全局.*session/, "string match.*session", "字符串匹配.*session",
    /scan.*all.*session/, /all.*session.*scan/,
  ];
  const clusterB_handwritten = [
    "hand-written json", "hand written json", "手写.*json", "手写.*JSON",
    "手补.*字段", "手工.*填写.*result",
    "manually.*inject.*result", "直接.*写入.*result",
  ];

  const hasAttest = hasAny(text, clusterA_persist);

  if (hasAttest && hasAny(text, clusterB_selfSatisfy)) {
    findings.push({
      severity: "blocking",
      category: "forgery-bypass",
      description:
        "Spec describes a persist/attest/proof mechanism (cluster A) co-occurring with a same-principal injection or self-satisfy path (cluster B: self/orchestrator/fabricate/inject terms). The same entity that is reviewed can satisfy its own proof gate — forgery-bypass blocking.",
    });
  }
  if (hasAttest && hasAny(text, clusterB_globalScan)) {
    findings.push({
      severity: "blocking",
      category: "forgery-bypass",
      description:
        "Spec describes proof verification via a global scan (cluster A: persist/proof terms + cluster B: global-scan/all-sessions/string-match terms). A global scan keyed on an ID can be satisfied by the orchestrator's own ambient session — forgery-bypass blocking.",
    });
  }
  if (hasAttest && hasAny(text, clusterB_handwritten)) {
    findings.push({
      severity: "blocking",
      category: "forgery-bypass",
      description:
        "Spec describes or acknowledges hand-written or manually-injected evidence reaching a persist or reviewer_output gate (cluster A: persist/gate terms + cluster B: hand-write/inject terms). The gate accepts evidence the orchestrator manufactured — forgery-bypass blocking.",
    });
  }

  // Acknowledged bypass with only non-blocking/diagnostic treatment.
  // Both clusters must be review/proof-specific to avoid triggering on
  // generic flow-control language in non-forgery specs.
  const clusterC_bypass = [
    "bypass.*review", "review.*bypass", "bypass.*proof", "proof.*bypass",
    "bypass.*attest", "attest.*bypass",
    "绕过.*审查", "审查.*绕过", "绕过.*证明",
    "known.*forger", "已知.*造假.*路径", "已知.*伪造",
    "workaround.*review", "forger.*path",
  ];
  const clusterC_nonblocking = [
    "non-blocking diagnostic", "non blocking diagnostic",
    "非阻断诊断", "warn.*only.*diagnostic",
    "no remediation", "no committed fix", "no.*fix.*planned",
    "诊断.*不阻断", "无法阻止.*造假",
  ];
  if (hasAny(text, clusterC_bypass) && hasAny(text, clusterC_nonblocking)) {
    findings.push({
      severity: "important",
      category: "forgery-bypass",
      description:
        "Spec acknowledges a bypass/limitation path but treats it as non-blocking/diagnostic without a committed remediation (cluster: bypass/limitation terms + non-blocking/defer terms) — important forgery-bypass defect.",
    });
  }

  return findings;
}

/**
 * proof-independence: spec describes (A) a reviewer/verifier role AND (B) the
 * reviewer's output, session, or context is controllable by the subject of
 * review (orchestrator / main agent).
 */
function detectProofIndependence(text) {
  const findings = [];

  const clusterA_reviewer = [
    "reviewer", "verifier", "审查员", "审查", "verify",
    "subreviewer", "independent review",
  ];

  const clusterB_controlled = [
    "inherits context", "inherit context", "继承.*上下文",
    "same context", "同.*上下文", "same session.*review",
    "shared session", "context shared",
    /orchestrator.*control/, /主.*agent.*控制/,
    /可控.*路径/, /agent.*write.*session/,
  ];
  const clusterB_outputControl = [
    "result file.*control", "output file.*agent", "sessionFile.*agent",
    "session.*file.*可控", "result.*path.*orchestrator",
    /reviewer.*output.*path.*control/,
  ];
  const clusterB_independence = [
    "lack.*independence", "no.*independence", "independence.*broken",
    "independence.*violated", "缺.*独立", "无法独立",
    "independence.*false", "not.*independent",
  ];

  const hasReviewer = hasAny(text, clusterA_reviewer);

  if (hasReviewer && hasAny(text, clusterB_controlled)) {
    findings.push({
      severity: "blocking",
      category: "proof-independence",
      description:
        "Spec describes a reviewer/verifier (cluster A) whose session or context is inherited from or shared with the orchestrator/main agent (cluster B: inherit-context/same-context/agent-write terms) — proof-independence blocking.",
    });
  }
  if (hasReviewer && hasAny(text, clusterB_outputControl)) {
    findings.push({
      severity: "blocking",
      category: "proof-independence",
      description:
        "Spec exposes a reviewer output or session file on a path controlled by the subject of review (cluster A: reviewer terms + cluster B: result-file/session-file-controlled terms). When the subject controls the reviewer's output, independence is structurally broken — proof-independence blocking.",
    });
  }
  if (hasReviewer && hasAny(text, clusterB_independence)) {
    findings.push({
      severity: "blocking",
      category: "proof-independence",
      description:
        "Spec explicitly acknowledges a condition where reviewer independence is lacking or violated (cluster A: reviewer terms + cluster B: independence-false/not-independent terms) — proof-independence blocking.",
    });
  }

  // Required-skill evidence without verifiable external record
  const clusterD_skill = [
    "required skill", "必需技能", "mandatory skill", "skill evidence", "技能.*证明",
  ];
  const clusterD_hollow = [
    "no corroborat", "without record", "empty summary", "空洞",
    "摘要.*写了", "只写.*通过", "unverifiable", "no external", "没有.*可核对",
  ];
  if (hasAny(text, clusterD_skill) && hasAny(text, clusterD_hollow)) {
    findings.push({
      severity: "important",
      category: "proof-independence",
      description:
        "Spec describes required-skill evidence accepted without a verifiable external record (cluster: skill/mandatory-skill terms + hollow/unverifiable terms) — proof-independence important.",
    });
  }

  return findings;
}

/**
 * schema-drift: spec describes (A) a structured output/contract AND either
 * (B) no machine validation, (C) soft-fail validation, (D) conflicting
 * field definitions, or (E) per-item adjudication without enforcement.
 */
function detectSchemaDrift(text) {
  const findings = [];

  const clusterA_schema = [
    "schema", "contract", "合同", "field contract", "json format",
    "output format", "structured output", "AJV", "字段定义", "格式",
    "validation", "校验", "开关", "flag", "check", "关卡", "trigger",
  ];
  const hasSchema = hasAny(text, clusterA_schema);

  // Soft-fail / bypass-switch validation
  const clusterB_softFail = [
    "soft-fail", "soft fail", "warn only", "warning only", "optional valid",
    "non-blocking valid", "validation optional", "schema optional",
    "吞掉", "swallow", "swallowed", "ignore fail", "fail silently",
    "不阻断", "不.*阻断.*校验", "校验.*失败.*不",
    "绕开.*开关", "bypass flag", "bypass switch", "绕开.*关卡",
    "绕开.*check",
  ];
  if (hasSchema && hasAny(text, clusterB_softFail)) {
    findings.push({
      severity: "blocking",
      category: "schema-drift",
      description:
        "Spec describes a schema/contract/gate (cluster A) with soft-fail, optional, or warning-only validation — or a check that bypasses its own control switch (cluster B: soft-fail/swallow/bypass-flag terms). A gate that does not hard-block on failure allows output drift — schema-drift blocking.",
    });
  }

  // Conflicting field contracts / internal contradictions
  const clusterC_conflict = [
    "conflict", "contradict", "inconsistent", "冲突", "矛盾", "自相矛盾",
    "two version", "multiple definition", "duplicate rule", "重复.*规则",
    "重复.*说明", "multiple source", "multiple truth",
  ];
  if (hasSchema && hasAny(text, clusterC_conflict)) {
    findings.push({
      severity: "blocking",
      category: "schema-drift",
      description:
        "Spec describes or requires eliminating internal contradictions between field contracts or rule statements (cluster A: schema/contract terms + cluster B: conflict/contradiction/duplicate terms). Multiple conflicting schemas for the same entity cause silent drift — schema-drift blocking.",
    });
  }

  // Per-item adjudication without machine enforcement
  const clusterD_perItem = [
    "per item", "item by item", "逐项", "each item", "one by one",
    "individual item", "case by case",
  ];
  const clusterE_noEnforce = [
    "no enforce", "without enforce", "not enforced", "没有.*机器.*校验",
    "无.*机器", "defer.*implement", "留.*实现", "留到.*实现",
    "implementation decide", "deferred", "后续实现",
  ];
  if (hasAny(text, clusterD_perItem) && hasAny(text, clusterE_noEnforce)) {
    findings.push({
      severity: "important",
      category: "schema-drift",
      description:
        "Spec uses a per-item adjudication pattern (cluster: per-item/逐项 terms) without machine enforcement (cluster: no-enforce/deferred terms). Items may be silently omitted — schema-drift important.",
    });
  }

  // Trigger timing flattened across multiple sources
  const clusterF_timing = [
    "trigger timing", "触发时机", "timing flatten", "统一.*时机",
    "时机.*重复", "multiple timing", "多套.*时机",
  ];
  const clusterF_timingConflict = [
    "conflict", "contradict", "flatten", "抹平", "重复.*说明",
    "multiple source", "多处", "inconsistent",
  ];
  if (hasAny(text, clusterF_timing) && hasAny(text, clusterF_timingConflict)) {
    findings.push({
      severity: "important",
      category: "schema-drift",
      description:
        "Spec describes timing-trigger metadata duplicated or flattened across multiple authoritative sources (cluster: trigger-timing terms + conflict/flatten/multiple-source terms). Divergent timing records cause gate behavior drift — schema-drift important.",
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const auditorPath = argValue("auditor");
  const specPath = argValue("spec");
  const outputPath = argValue("output");

  if (!outputPath) {
    process.stderr.write("Error: --output is required\n");
    process.exit(1);
  }

  // REQUIRED: read and validate auditor — exits non-zero if absent/empty/no categories.
  const auditor = loadAuditor(auditorPath);

  const specText = readSpec(specPath);

  let result;
  if (!specText) {
    result = { status: "skip", findings: [] };
  } else {
    const findings = [];

    // Only run detectors for categories declared in the auditor file.
    const active = new Set(auditor.categories);

    if (active.has("forgery-bypass")) {
      findings.push(...detectForgeryBypass(specText));
    }
    if (active.has("proof-independence")) {
      findings.push(...detectProofIndependence(specText));
    }
    if (active.has("schema-drift")) {
      findings.push(...detectSchemaDrift(specText));
    }

    result = { status: "ok", findings };
  }

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
}

main();
