#!/usr/bin/env node
// route-review.mjs — 自适应路由（RD-5 / FR-ROUTE-001/002/003）
//
// 单一规则表 route-rules.json 驱动；阈值/档位不在代码内写死。
// 环境探测层（env）与策略层（contentType/scope）分离：env 只影响落盘/门禁路径，
// 不缩小审查范围。判定为纯函数：同输入必产同输出（可复现）。
//
// 用法（CLI）：
//   route-review.mjs --input=<path|-> [--task-dir=<dir>] [--diff-lines=N] [--out=<path>]
// 模块用法：
//   import { routeReview } from "./route-review.mjs";
//   const decision = routeReview({ input, taskDir, hasState, diffLines, providers });
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, "..", "config", "route-rules.json");

function loadRules() {
  return JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
}

// ── 环境探测层（与策略层分离）──
// agenthub = task-dir 存在且含 state.json；否则 standalone。工具种类不在此缩范围。
function detectEnv({ taskDir, hasState }) {
  if (!taskDir) return "standalone";
  if (hasState === true) return "agenthub";
  // 真实 task-dir：探测 state.json（source-derived 或 flat）
  try {
    const sd = path.join(taskDir, ".machine", "source", "state.json");
    const flat = path.join(taskDir, "state.json");
    if (fs.existsSync(sd) || fs.existsSync(flat)) return "agenthub";
  } catch { /* fall through */ }
  return "standalone";
}

// ── 策略层：docs-only 文件特征探测（正交叠加，不替代 size 分级）──
// Returns true iff ALL diff-header changed files match .md or docs/ prefix,
// AND none of them matches the excludes list (.json/.yaml/.toml = config files).
// A config file present in the same diff → NOT docs-only (falsifiability guarantee).
function detectDocsOnly(input) {
  const text = String(input || "");
  // Extract changed file paths from unified-diff headers (diff --git a/X b/X or --- a/X)
  const diffFilePattern = /^(?:diff --git a\/(\S+)|--- a\/(\S+)|(\+\+\+) b\/(\S+))/gm;
  const files = [];
  let m;
  while ((m = diffFilePattern.exec(text)) !== null) {
    // Prefer "diff --git a/<path>" captures (group 1), fall back to --- a/<path> (group 2)
    const f = m[1] ?? m[2];
    if (f && f !== "/dev/null") files.push(f);
  }
  if (files.length === 0) return false;
  const CONFIG_EXTS = [".json", ".yaml", ".toml"];
  for (const f of files) {
    // Exclude if any config extension present
    if (CONFIG_EXTS.some((ext) => f.endsWith(ext))) return false;
    // Must match .md extension or docs/ path prefix
    if (!f.endsWith(".md") && !f.startsWith("docs/")) return false;
  }
  return true;
}

// ── 策略层：contentType（命中优先级 design > plan > docs-only > code-diff > text-record）──
// docs-only takes priority over code-diff when the diff exclusively touches .md/docs/ files:
// a "diff --git a/README.md b/README.md" is still a diff structurally, but its CONTENT is
// pure documentation, so docs-only wins. design and plan signals (explicit markers) always
// win — they are semantic intent annotations. code-diff wins only when files are NOT docs-only.
// This keeps the overlay orthogonal: the size-tier logic is untouched.
function detectContentType(input, rules) {
  const text = String(input || "");
  // design-doc and plan-doc always win (explicit intent markers, highest priority)
  for (const rule of rules.contentType.detect) {
    if (rule.default || rule.type === "docs-only" || rule.type === "code-diff") continue;
    if ((rule.signals || []).some((s) => text.includes(s))) return rule.type;
  }
  // docs-only: check before code-diff — a diff of exclusively .md/docs/ files is docs-only,
  // not code-diff (even though it contains diff structural markers).
  if (detectDocsOnly(text)) return "docs-only";
  // code-diff: fires when diff markers present but NOT docs-only
  const codeDiffRule = rules.contentType.detect.find((r) => r.type === "code-diff");
  if (codeDiffRule && (codeDiffRule.signals || []).some((s) => text.includes(s))) return "code-diff";
  const def = rules.contentType.detect.find((r) => r.default);
  return def ? def.type : "text-record";
}

// ── 策略层：scope（diff 阈值分档 + 风险关键词只升不降）──
function detectScope(input, contentType, diffLines, rules) {
  const text = String(input || "");
  const thresholds = rules.scope.diffThresholds;
  let scope;
  if (contentType === "code-diff") {
    const lines = Number.isFinite(diffLines) ? diffLines : 0;
    if (lines <= 0) scope = "trivial";
    else {
      scope = thresholds[thresholds.length - 1].scope; // default large
      for (const t of thresholds) {
        if (t.maxLines != null && lines <= t.maxLines) { scope = t.scope; break; }
      }
    }
  } else {
    scope = rules.scope.nonDiffDefault; // 非 diff 保守落 small，不缩范围
  }
  // 风险关键词：命中则升到 escalateTo（只升不降）
  const rk = rules.scope.riskKeywords;
  const order = rules.scope.values; // [trivial, small, medium, large]
  if (rk.keywords.some((k) => text.includes(k))) {
    if (order.indexOf(rk.escalateTo) > order.indexOf(scope)) scope = rk.escalateTo;
  }
  return scope;
}

// ── 路由层：level（三值枚举，决定子代理策略）──
// Authoritative routing table (tasks.md:58 Phase 2 GREEN contract: 大→R1, 中等→R2, 小/fast→R6;
// decision-log D2(b): 小改/影响小/纯文档→同源子代理 R6):
//   no_external_cli (any scope) → same_source_subagent (R6)
//   text-record (any scope)     → same_source_subagent (R6)
//   scope=trivial               → same_source_subagent (R6)
//   scope=small                 → same_source_subagent (R6)
//   scope=medium                → cross_source_no_subagent (R2)
//   scope=large                 → cross_source_with_subagent (R1)
// Decision steps (ordered):
// (a) envProbe === "no_external_cli" → R6 (short-circuit)
// (b) contentType === "text-record" || scope ∈ {trivial, small} → R6 (small/pure-doc to same-source)
// (c) cross-source by size: scope large → R1; scope medium → R2
function detectLevel(contentType, scope, envProbe) {
  // (a) env short-circuit
  if (envProbe === "no_external_cli") {
    return {
      level: "same_source_subagent",
      basis: "env=no_external_cli → forced same-source",
    };
  }
  // (b) small / pure-doc — trivial AND small both route same-source (cost goal: 小问题不起全套异源)
  // docs-only always routes R6: documentation-only changes need no cross-source review overhead.
  if (contentType === "text-record" || contentType === "docs-only" || scope === "trivial" || scope === "small") {
    return {
      level: "same_source_subagent",
      basis: `contentType=${contentType}, scope=${scope} → R6 same-source (small/pure-doc/docs-only)`,
    };
  }
  // (c) cross-source by scope size — only LARGE warrants the subagent route (R1);
  //     medium is cross-source without subagent (R2). tasks.md GREEN: 大→R1, 中等→R2.
  if (scope === "large") {
    return {
      level: "cross_source_with_subagent",
      basis: `cross-source by scope=${scope} → R1 with subagent`,
    };
  }
  // scope === "medium"
  return {
    level: "cross_source_no_subagent",
    basis: `cross-source by scope=${scope} → R2 no subagent`,
  };
}

export function routeReview({ input = "", taskDir = null, hasState = undefined, diffLines = 0, providers = [], envProbe = undefined, fast = false, phaseType = undefined, envOverride = undefined } = {}) {
  const rules = loadRules();
  const env = envOverride ?? detectEnv({ taskDir, hasState });

  // phaseType explicit marker: when passed, short-circuit content inference and route directly.
  // This avoids re-analyzing the diff and lets the caller declare the type authoritatively.
  // docs-only phaseType → contentType="docs-only" regardless of input content (T027 / FR-ROUTE-003).
  // Schema-drift guard: an explicit marker MUST be a valid route_decision contentType. An unknown
  // value (e.g. a typo "docs_only") must fail fast — otherwise it falls through as a bogus
  // contentType and silently downgrades a large code diff to R6 same-source review.
  let contentType;
  if (phaseType !== undefined) {
    const marker = String(phaseType);
    if (!rules.contentType.values.includes(marker)) {
      throw new Error(
        `invalid phaseType "${marker}": must be one of route_decision contentType enum ` +
          `[${rules.contentType.values.join(", ")}] (fail-fast to avoid silent R6 downgrade)`
      );
    }
    contentType = marker;
  } else {
    contentType = detectContentType(input, rules);
  }

  const scope = detectScope(input, contentType, diffLines, rules);

  // selected = 本轮审查投入档位；rejected = 被排除档位 + reason（可审计）
  const allScopes = rules.scope.values;
  const selected = scope;
  const rejected = allScopes
    .filter((s) => s !== scope)
    .map((s) => ({
      option: s,
      reason:
        s === "trivial" && scope !== "trivial"
          ? "content has changes / risk beyond trivial"
          : `scope resolved to '${scope}' for contentType=${contentType} (diffLines=${diffLines}); '${s}' not selected`,
    }));

  const reason =
    `env=${env} (detection layer, does not narrow scope); ` +
    `contentType=${contentType}; scope=${scope} ` +
    `(diff thresholds + risk-keyword escalation per route-rules.json v${rules.rulesVersion})`;

  // FR-FAST-001: --fast is a user manual override that skips the 强制异源审查 + 子代理预审
  // and forces same_source_subagent (R6). It overrides the adaptive 三步判定 level only;
  // env/contentType/scope are still computed so basis stays auditable. FR-FAST-002: --fast
  // does not change result-field contracts — only the routing level.
  const computed = detectLevel(contentType, scope, envProbe);
  const { level, basis } = fast
    ? {
        level: "same_source_subagent",
        basis: `--fast user override → R6 same-source (skips 强制异源审查 + 子代理预审; would otherwise be: ${computed.basis})`,
      }
    : computed;

  // routeReview() is a PURE function: identical input → identical decision.
  // No wall-clock timestamp here (would break the reproducibility contract above).
  // Timestamping belongs to the CLI/history-persistence boundary (FR-TRACE, Phase 6).
  return {
    env,
    contentType,
    scope,
    selected,
    rejected,
    reason,
    rulesVersion: rules.rulesVersion,
    providers: Array.isArray(providers) ? providers : [],
    level,
    basis,
  };
}

// ── enforceCleanContext (FR-QUALITY-001) ──
// Same-host sub-agents must run in a clean (isolated) context to prevent
// prior conversation context bleeding into the review. If the routeDecision
// already carries cleanContext:true (the caller has already handled isolation),
// no additional enforcement is needed. Otherwise, set cleanContextRequired:true
// so the adapter can mechanically guarantee isolation without relying on discipline.
export function enforceCleanContext(routeDecision = {}) {
  const decision = { ...routeDecision };
  if (decision.cleanContext === true) {
    // Already marked as isolated — no force needed.
    decision.cleanContextRequired = false;
  } else {
    // Force clean context: adapter must route through isolated prompt path.
    decision.cleanContextRequired = true;
  }
  return decision;
}

// ── countExternalCodex (FR-TRACE-001, 验收维度A 数据源) ──
// externalCodexCount = number of external codex PROCESSES launched this round.
// A full cross-source round launches one codex per executed subreviewer lens PLUS
// the final reviewer; a --fast / claude round launches zero. This is the SOLE data
// source for acceptance standard 1 dimension A (after < before strict decrease), so
// it must reflect ALL codex launches, not just the final reviewer (final-only ⇒ always 1
// ⇒ dimension A loses discriminating power).
//
// Data source is the REAL bundle the adapter passes (DELEGATED_BUNDLE_FILE from
// run-delegated-precheck.mjs L1662-1672): subreviewerRuntimeReports[] at TOP LEVEL.
// The bundle's reports[] carries NO provider field (it never has — reading it
// collapsed the count to final-only=1 and killed dimension A's discriminating power).
//
// A subreviewer counts as a launched external codex process iff its runtime
// sessionFile is under /.codex/sessions/ — the positive codex-dispatch signal
// (extract-codex-meta.mjs only resolves a /.codex/ session path when codex actually
// ran). NOT by array length: claude FR-REVIEW-003 fallback subreviewers ALSO appear
// in subreviewerRuntimeReports, but their sessionFile is the resultFile path
// (runtimeReport L345 fallback), NOT under /.codex/ — counting length would
// over-count claude fallback as codex. NOT by tokenUsageSource/modelEvidence
// substring "codex": the fallback string "codex session token meta unavailable"
// appears for claude fallback too, so substring matching over-counts.
//
// Residual under-count (codex ran but meta-extract failed → sessionFile falls back
// to resultFile) is graceful: before is still anchored ≥1 by the codex final
// reviewer's +1, after on the --fast path is always 0, so after<before stays honest.
function _isCodexSessionFile(p) {
  return typeof p === "string" && p.includes("/.codex/");
}
function _resolveRuntimeReports(bundle) {
  if (!bundle || typeof bundle !== "object") return [];
  if (Array.isArray(bundle.subreviewerRuntimeReports)) return bundle.subreviewerRuntimeReports;
  if (bundle.delegatedReviewBundle && Array.isArray(bundle.delegatedReviewBundle.subreviewerRuntimeReports)) {
    return bundle.delegatedReviewBundle.subreviewerRuntimeReports;
  }
  return [];
}
export function countExternalCodex(bundle = {}, finalReviewerProvider = "") {
  const runtimeReports = _resolveRuntimeReports(bundle);
  let count = 0;
  for (const r of runtimeReports) {
    if (r && typeof r === "object" && _isCodexSessionFile(r.sessionFile)) count += 1;
  }
  if (typeof finalReviewerProvider === "string" && finalReviewerProvider.toLowerCase() === "codex") count += 1;
  return count;
}

// ── applyPostRoundDegradation (FR-DEG-001/002/003) ──
// Post-round routing degradation: given prior-round review history, decide whether the
// current routing level should be downgraded (cheaper same-source review) or kept/raised
// to full cross-source-with-subagent. Pure function — judges by finding count + severity,
// NEVER by diff line count (so non-diff objects like design/plan/intake are handled the
// same way as code diffs). The current decision's level is the full-scope baseline.
//
// Rules (FR-DEG-001/002/003):
//   - NEW blocking under already-downgraded (R6) round AND the blocking is a "new domain"
//     (per route-rules.json degradation.newDomainRules) → re-escalate to full scope (R1). (FR-DEG-002)
//   - NEW blocking under already-downgraded (R6) round but NOT new-domain → STAY on R6.
//     Stickiness: do NOT auto-escalate for same-domain repeat blockings. (FR-DEG-001)
//   - previous round finding count ≤ maxFindingsForDowngrade (including a single blocking)
//     OR ≥ threshold+1 findings but ALL non-blocking → downgrade to same_source_subagent (R6).
//   - previous round had ≥ threshold+1 findings AND at least one blocking → keep full scope (R1).
// A downgraded (R6) decision MUST carry clean-context enforcement (FR-QUALITY-001 reuse).
//
// "new domain" detection (FR-DEG-003): config-driven via route-rules.json degradation.newDomainRules.
// A finding is "new-domain" if it carries a domain/lensType/codePath not seen in ANY prior round
// BEFORE the downgraded round. Match by: domainLabels, pathPrefixes, lensTypes — any dimension.
const FULL_SCOPE_LEVEL = "cross_source_with_subagent"; // R1 — 最重档
const MID_LEVEL = "cross_source_no_subagent";           // R2 — 中间档 (FR-DEG / A-DEG1)
const DOWNGRADED_LEVEL = "same_source_subagent";        // R6 — 最轻档

// Tier ordering, heaviest→lightest. "downgrade one tier" walks this array toward R6.
// Sourced from config degradation.tierOrder when present (A-DEG3: not hardcoded), with the
// three known levels as a defensive fallback if config omits it.
function tierOrderOf(rules) {
  const fromCfg = rules && rules.degradation && Array.isArray(rules.degradation.tierOrder)
    ? rules.degradation.tierOrder
    : null;
  return fromCfg && fromCfg.length ? fromCfg : [FULL_SCOPE_LEVEL, MID_LEVEL, DOWNGRADED_LEVEL];
}
// Return the level one step lighter than `level`; if already lightest, stay.
// Unknown (unrecognized) level → explicit error (fail-fast, FR-ROUTE-003/004).
function downgradeOneTier(level, rules) {
  const order = tierOrderOf(rules);
  const i = order.indexOf(level);
  if (i < 0) {
    throw new Error(
      `downgradeOneTier: unknown current level "${level}" — must be one of ` +
        `${JSON.stringify(order)} (fail-fast, no silent fallback)`
    );
  }
  return i >= order.length - 1 ? order[i] : order[i + 1];
}

function findingsOf(entry) {
  return Array.isArray(entry && entry.findings) ? entry.findings : [];
}
function blockingFindings(findings) {
  return findings.filter((f) => f && f.severity === "blocking");
}
function hasBlocking(findings) {
  return findings.some((f) => f && f.severity === "blocking");
}

// FR-DEG-004 (A-DEG3): hard-guardrail classification is CONFIG-driven. A finding is a hard
// guardrail iff any of its blockerClass/riskType/sourceType/contractId fields matches a value
// configured under degradation.hardGuardrailCriteria. No criteria configured → nothing is a
// hard guardrail (defensive: never silently keeps full scope without explicit config).
function isHardGuardrailBlocking(finding, rules) {
  if (!finding || finding.severity !== "blocking") return false;
  const crit = rules && rules.degradation && rules.degradation.hardGuardrailCriteria;
  if (!crit) return false;
  const fieldMatches = (fieldName) => {
    const cfgList = crit[fieldName];
    if (!Array.isArray(cfgList) || cfgList.length === 0) return false;
    const val = finding[fieldName];
    return val !== undefined && val !== null && cfgList.includes(val);
  };
  return fieldMatches("blockerClass") || fieldMatches("riskType") || fieldMatches("sourceType") || fieldMatches("contractId");
}

// FR-DEG (repeated-blocking → escalate): a "fingerprint" for a blocking finding so the SAME
// unresolved blocking can be recognized across rounds. Identity = file/codePath + blockerClass +
// normalized issue text. The real reviewer finding shape carries `blockerClass` and `issue`
// (NOT `category`/`description`), so reading those is what makes the fingerprint discriminate by
// the actual problem instead of collapsing to a bare filename match (which let reviewers dodge
// escalation by re-reporting the same root problem under a different file). The issue text is
// CONSERVATIVELY normalized (lowercase, strip line refs / absolute path prefixes / punctuation,
// collapse whitespace) — no synonym/semantic matching, so genuinely different problems keep
// distinct fingerprints. Findings missing all three identity parts are not fingerprintable
// (return null) and never trip the escalation (avoids false escalates on under-specified findings).
function _normalizeIssue(s) {
  if (!s) return "";
  let t = String(s).toLowerCase();
  // Basename-ify ANY path whose final segment has a file extension — absolute (/Users/a/b/foo.ts → foo.ts)
  // AND relative (src/foo.ts → foo.ts, a/b/c/foo.mjs → foo.mjs). The leading boundary is a lookbehind
  // (?<=^|[\s(\[{'"`]) so the char before the path (space, open-bracket, backtick, …) is NOT consumed and
  // therefore not glued onto the basename; `\/?` then optionally eats an absolute leading slash, and
  // `(?:[^\s/)]+\/)+` eats one-or-more `segment/` dir parts so at least one slash is required (a bare
  // `foo.ts` is already a basename and is left untouched).
  // Route/API text without an extension segment (e.g. /api/v1/users, /admin/users) is preserved verbatim,
  // so different endpoints reporting the same symptom do NOT collapse into one fingerprint (false-merge → false escalate).
  // Extension must contain at least one LETTER (\.[a-z][a-z0-9]*): real source extensions
  // (.ts/.go/.mjs) stay basename-ified, but a pure-numeric tail like a version segment (/api/v1.2)
  // is NOT treated as a file extension — otherwise two distinct API routes sharing a version number
  // collapse into one fingerprint (false merge → false escalate). A dotted token with no slash (a.com,
  // v1.2) is never matched (the dir-segment requirement needs a slash). The trailing lookahead also
  // accepts wrapping punctuation/backticks (`. , ; ! ? ' " ] }`) that the punctuation pass below
  // strips anyway, so `/Users/a/b/foo.ts,` / `src/foo.ts.` / `` `src/foo.ts` `` all basename-ify rather
  // than leaving the path prefix behind (drift dodge: same blocking re-pathed/re-punctuated to evade fingerprint).
  t = t.replace(/(?<=^|[\s(\[{'"`])\/?(?:[^\s/)]+\/)+([^\s/)]+\.[a-z][a-z0-9]*)(?=[\s:),.;!?'"`\]}]|$)/gi, "$1");
  // Drop line-number references: `:123`, `line 45`, `L45`.
  t = t.replace(/:\d+\b/g, " ");
  t = t.replace(/\bline\s+\d+\b/g, " ");
  t = t.replace(/\bl\d+\b/g, " ");
  // Drop common ASCII + CJK punctuation/quotes/brackets.
  t = t.replace(/[.,;:!?'"`()\[\]{}<>，。、；：！？“”‘’（）【】《》]/g, " ");
  // Collapse runs of whitespace to a single space, trim ends.
  t = t.replace(/\s+/g, " ").trim();
  return t;
}
function _blockingFingerprint(f) {
  if (!f || f.severity !== "blocking") return null;
  const file = f.codePath || f.file || "";
  const blockerClass = f.blockerClass || "";
  const issue = _normalizeIssue(f.issue || f.description || f.core || f.summary || "");
  // issue is the necessary discriminating dimension: an empty issue cannot distinguish two
  // genuinely different problems that share file/blockerClass. Treat an empty-issue finding as
  // not fingerprintable (return null) so it never trips repeated-blocking escalation — fail-open
  // (no escalate) is safer than a false escalate driven by a single non-discriminating field.
  if (!issue) return null;
  return `${file}\u0000${blockerClass}\u0000${issue}`;
}
// Returns { repeated, priorRound, fingerprintParts } describing whether at least one blocking
// finding in the LAST round shares a fingerprint with a blocking finding in an earlier round.
//
// Compare window: NOT the unbounded full history. We scan back only to the most recent
// "blocking-free round" (a round whose findings contain NO blocking) — the clean-account
// boundary. A blocking that was fully cleared in some intermediate round and then resurfaces is a
// NEW regression, not an unresolved-across-rounds blocking, so it must NOT prematurely escalate to
// human (A→clean→A is fine; A→B→A with no clean round in between still escalates). If the whole
// history has no blocking-free round, the window is the full history (0..lastIdx-1) — identical to
// the previous unbounded behavior, so the alternating-file drift dodge (A→B→A) is still caught.
//
// Only fingerprintable (non-null) findings participate, so under-specified findings never cause a
// false escalate. fingerprintParts records the matched prior finding's identity dimensions
// (file/blockerClass/issue) so the caller can write an accurate, current-field escalation basis.
function _hasRepeatedBlocking(rounds, lastIdx) {
  if (lastIdx < 1) return { repeated: false };
  // Find the most recent blocking-free round strictly before lastIdx; scan window starts AFTER it.
  let windowStart = 0;
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (!hasBlocking(findingsOf(rounds[i]))) { windowStart = i + 1; break; }
  }
  // Map fingerprint → { round, parts } for every prior blocking in the window.
  const priorPrints = new Map();
  for (let i = windowStart; i < lastIdx; i++) {
    for (const f of blockingFindings(findingsOf(rounds[i]))) {
      const fp = _blockingFingerprint(f);
      if (fp && !priorPrints.has(fp)) {
        priorPrints.set(fp, {
          round: rounds[i].round ?? i + 1,
          parts: {
            file: f.codePath || f.file || "",
            blockerClass: f.blockerClass || "",
            issue: _normalizeIssue(f.issue || f.description || f.core || f.summary || ""),
          },
        });
      }
    }
  }
  if (priorPrints.size === 0) return { repeated: false };
  for (const f of blockingFindings(findingsOf(rounds[lastIdx]))) {
    const fp = _blockingFingerprint(f);
    if (fp && priorPrints.has(fp)) {
      const m = priorPrints.get(fp);
      return { repeated: true, priorRound: m.round, fingerprintParts: m.parts };
    }
  }
  return { repeated: false };
}

// Collect domain/lensType/codePath values covered by the IMMEDIATELY PREVIOUS round only.
// FR-DEG-002 (spec.md): "上轮未覆盖的领域" — the comparison boundary is the single
// previous round's coverage, NOT the union of all earlier rounds. A domain seen in an
// older round but absent from the previous round still counts as "new" and re-escalates.
function _collectPriorDomains(rounds, lastIdx) {
  const domains = new Set();
  const lensTypes = new Set();
  const paths = new Set();
  const prevIdx = lastIdx - 1;
  if (prevIdx >= 0) {
    for (const f of findingsOf(rounds[prevIdx])) {
      if (f.domain) domains.add(f.domain);
      if (f.lensType) lensTypes.add(f.lensType);
      if (f.codePath) paths.add(f.codePath);
    }
  }
  return { domains, lensTypes, paths };
}

// Returns true iff at least one blocking finding in `findings` qualifies as "new domain"
// per the config-driven newDomainRules.
function _hasNewDomainBlocking(findings, priorDomains, rules) {
  const newDomainRules = rules.degradation && rules.degradation.newDomainRules;
  if (!newDomainRules) return false;
  const configDomainLabels = new Set(newDomainRules.domainLabels || []);
  const configLensTypes = new Set(newDomainRules.lensTypes || []);
  const configPathPrefixes = newDomainRules.pathPrefixes || [];

  for (const f of findings) {
    if (!f || f.severity !== "blocking") continue;
    // Check domain label: finding.domain is in config list AND not seen in prior rounds
    if (f.domain && configDomainLabels.has(f.domain) && !priorDomains.domains.has(f.domain)) {
      return true;
    }
    // Check lensType: finding.lensType is in config list AND not seen in prior rounds
    if (f.lensType && configLensTypes.has(f.lensType) && !priorDomains.lensTypes.has(f.lensType)) {
      return true;
    }
    // Check codePath prefix: matches a configured prefix AND not seen in prior rounds
    if (f.codePath && configPathPrefixes.some((pfx) => f.codePath.startsWith(pfx))) {
      if (!priorDomains.paths.has(f.codePath)) return true;
    }
  }
  return false;
}

// FR-CFG-001: mid-tier (R2) switch. Read from config degradation.midTier.enabled (spec contract key).
// Explicit null-check default: only an explicit `false` disables (!== false). Missing key → true.
function _midTierEnabled(rules) {
  const flag = rules
    && rules.degradation
    && rules.degradation.midTier
    && rules.degradation.midTier.enabled;
  return flag !== false;
}

// `opts.rules` lets callers/tests inject a rules object (e.g. mid-tier flag flipped) without
// mutating the committed route-rules.json; default is the live config via loadRules().
export function applyPostRoundDegradation(history = [], currentDecision = {}, opts = {}) {
  const decision = { ...currentDecision };
  const rounds = Array.isArray(history) ? history : [];
  if (rounds.length === 0) {
    // No history → no degradation signal; keep the current decision untouched.
    return decision;
  }

  const rules = (opts && opts.rules) ? opts.rules : loadRules();
  const midTier = _midTierEnabled(rules);

  const lastIdx = rounds.length - 1;
  const last = rounds[lastIdx];
  const lastFindings = findingsOf(last);
  const lastWasDowngraded = last && last.level === DOWNGRADED_LEVEL;
  const blockings = blockingFindings(lastFindings);
  const blocking = blockings.length > 0;
  const hardGuardrail = blockings.some((f) => isHardGuardrailBlocking(f, rules));

  // (a) HIGHEST PRIORITY — same blocking finding repeated across rounds (same
  //     file/category/core-description) → escalate to human; do NOT downgrade.
  //     This must run BEFORE the R6 stickiness branch (B1): a blocking that is stuck under an
  //     already-downgraded (R6) round is same-domain by construction, so the stickiness branch
  //     would otherwise re-route it back to the cheapest path and the escalation would never
  //     fire (FR-DEG-002 violation). Surfacing a stuck blocking wins over tier stickiness.
  const repeat = _hasRepeatedBlocking(rounds, lastIdx);
  if (repeat.repeated) {
    const p = repeat.fingerprintParts || {};
    const ident = `file="${p.file ?? ""}" blockerClass="${p.blockerClass ?? ""}" issue="${p.issue ?? ""}"`;
    decision.escalate = true;
    decision.basis = `post-round escalation: same blocking finding unresolved across rounds ${repeat.priorRound ?? "?"}→${last.round ?? lastIdx + 1} (matched on ${ident}) → escalate_to_human (FR-DEG repeated-blocking)`;
    return decision;
  }

  // (b) NEW (non-repeated) blocking under an already-downgraded (R6) round.
  //     FR-DEG-001 stickiness: only re-escalate to R1 if the blocking is "new domain" (FR-DEG-002).
  //     Same-domain (non-repeated) blockings under R6 stay on R6 (no unconditional escalation).
  //     Preserved across the 3-tier rewrite. Repeated blockings are already handled above (a).
  if (lastWasDowngraded && blocking) {
    const priorDomains = _collectPriorDomains(rounds, lastIdx);
    const isNewDomain = _hasNewDomainBlocking(lastFindings, priorDomains, rules);
    if (isNewDomain) {
      decision.level = FULL_SCOPE_LEVEL;
      decision.basis = `post-round re-escalation: new-domain blocking under downgraded round ${last.round ?? "?"} → R1 full scope (FR-DEG-001/002)`;
      return decision;
    }
    // Same-domain blocking: stickiness — stay on R6, do not escalate.
    decision.level = DOWNGRADED_LEVEL;
    decision.basis = `post-round stickiness: blocking under downgraded round ${last.round ?? "?"} is same-domain (not new-domain) → stay R6 (FR-DEG-001)`;
    return enforceCleanContext(decision);
  }

  // Mid-tier OFF (FR-CFG-001): fall back to the OLD binary R1/R6 behavior — no R2 ever.
  //   - count ≤ maxFindingsForDowngrade (incl single blocking) OR no blocking → R6.
  //   - otherwise (>threshold AND blocking) → keep R1.
  if (!midTier) {
    const degradCfg = rules.degradation || {};
    const maxFindingsForDowngrade = typeof degradCfg.maxFindingsForDowngrade === "number"
      ? degradCfg.maxFindingsForDowngrade
      : 1;
    const count = lastFindings.length;
    if (count <= maxFindingsForDowngrade || !blocking) {
      decision.level = DOWNGRADED_LEVEL;
      decision.basis = `post-round degradation (midTier OFF, binary): previous round had ${count} finding(s) → R6 same-source`;
      return enforceCleanContext(decision);
    }
    decision.basis = `post-round (midTier OFF, binary): previous round had ${count} finding(s) incl blocking → keep R1 full scope`;
    return decision;
  }

  // ── 3-tier matrix (mid-tier ON) by LAST round severity (FR-DEG-001..004) ──
  // (3) >1 blocking OR any hard-guardrail blocking → keep R1 (most-heavy).
  if (blockings.length > 1 || hardGuardrail) {
    decision.basis = hardGuardrail
      ? `post-round: hard-guardrail blocking in previous round → keep R1 full scope (FR-DEG-004)`
      : `post-round: ${blockings.length} blocking finding(s) in previous round → keep R1 full scope (FR-DEG-003)`;
    return decision;
  }

  // (2) exactly 1 NON-hard-guardrail blocking → mid tier R2.
  if (blockings.length === 1) {
    decision.level = MID_LEVEL;
    decision.basis = `post-round mid-tier degradation: single non-hard-guardrail blocking in previous round → R2 cross-source no-subagent (FR-DEG-001/004)`;
    return decision;
  }

  // (1) no blocking, few findings → downgrade ONE tier from current (R1→R2→R6, R6 stays).
  const next = downgradeOneTier(decision.level, rules);
  decision.level = next;
  decision.basis = `post-round one-tier degradation: previous round had ${lastFindings.length} finding(s), no blocking → step down one tier to ${next} (FR-DEG-001, by finding count + severity)`;
  // Only the lightest tier (R6) requires clean-context enforcement (FR-QUALITY-001 reuse).
  return next === DOWNGRADED_LEVEL ? enforceCleanContext(decision) : decision;
}

// ── CLI ──
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
  const get = (n) => {
    const a = args.find((x) => x.startsWith(`--${n}=`));
    return a ? a.slice(n.length + 3) : undefined;
  };
  const inputArg = get("input");
  let input = "";
  if (inputArg === "-" || inputArg === undefined) {
    input = fs.readFileSync(0, "utf8");
  } else {
    input = fs.readFileSync(inputArg, "utf8");
  }
  const taskDir = get("task-dir") || null;
  const diffLines = get("diff-lines") !== undefined ? Number(get("diff-lines")) : 0;
  const envProbe = get("env-probe");
  // --fast is a bare flag (not --fast=...), so get() does not see it; match it directly.
  const fast = args.includes("--fast");

  // --history=<file>: read route-decision-history.jsonl (one JSON per line) and apply
  // post-round degradation. File absence or empty file = no history = no degradation.
  // FR-DEGRADE-001/002: applyPostRoundDegradation is the sole degradation path; no inline logic.
  //
  // --checkpoint=<id>: when present, filter history to only records whose checkpoint field
  // matches. This prevents cross-checkpoint contamination: a new checkpoint's round=1 must
  // NOT see prior-checkpoint history (FR-DEGRADE-002 first-round discipline). Records without
  // a checkpoint field are treated as unattributable and excluded when --checkpoint is given.
  // When --checkpoint is absent, no filter is applied (backward compat: existing behavior).
  const historyArg = get("history");
  const checkpointArg = get("checkpoint");
  let history = [];
  if (historyArg) {
    try {
      const raw = fs.readFileSync(historyArg, "utf8");
      const allRecords = raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      // FR-DEGRADE-002 checkpoint isolation: filter to only same-checkpoint records.
      history = checkpointArg
        ? allRecords.filter((r) => r && r.checkpoint === checkpointArg)
        : allRecords;
    } catch { /* file missing or unreadable — treat as no history */ }
  }

  const baseDecision = enforceCleanContext(routeReview({ input, taskDir, diffLines, envProbe, fast }));
  const decision = applyPostRoundDegradation(history, baseDecision);
  const out = get("out");
  const json = JSON.stringify(decision, null, 2);
  if (out) fs.writeFileSync(out, json + "\n");
  else process.stdout.write(json + "\n");
}
