import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_MD = path.join(here, "SKILL.md");

/**
 * Provider-name scan: the 3rd-review SKILL.md must be free of
 * provider-brand identifiers (Codex as reviewer identity, codex-companion,
 * etc.).  Tool invocations (`codex exec`), filesystem paths, env vars,
 * and package names are on the allowlist and not counted as violations.
 *
 * Phase 5 de-branding target: 0 violations (allowlist exempted).
 */

// ── Allowlist: line-number ranges or exact line patterns that are OK ──
// Each entry is { line: number } for exact-line exemption, or
// { startLine: number, endLine: number } for range exemption.
// These cover CLI invocations, env vars, paths, and package references
// that legitimately contain "codex"/"Codex" as tool names, not provider identity.
interface AllowlistEntry {
  startLine: number;
  endLine: number;
  reason: string;
}

function buildAllowlist(content: string): AllowlistEntry[] {
  const lines = content.split("\n");
  const entries: AllowlistEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ln = i + 1; // 1-based

    // CLI invocation: command codex, codex exec, codex login, codex --version
    if (
      /command codex/.test(line) ||
      /codex exec/.test(line) ||
      /codex login/.test(line) ||
      /codex --version/.test(line) ||
      /npx @openai\/codex/.test(line) ||
      /npm install -g @openai\/codex/.test(line)
    ) {
      entries.push({ startLine: ln, endLine: ln, reason: "CLI tool invocation" });
      continue;
    }

    // Env var references
    if (/CODEX_SKILLS|CODEX_REVIEW_TIMEOUT_SECONDS/.test(line)) {
      entries.push({ startLine: ln, endLine: ln, reason: "environment variable name" });
      continue;
    }

    // Filesystem paths
    if (/\$HOME\/\.codex\/|~\/\.codex\/|CODEX_SKILLS=/.test(line)) {
      entries.push({ startLine: ln, endLine: ln, reason: "filesystem path" });
      continue;
    }

    // Package names
    if (/@openai\/codex/.test(line)) {
      entries.push({ startLine: ln, endLine: ln, reason: "package name" });
      continue;
    }

    // Script filename references (extract-codex-meta is a filename, not branding)
    if (/extract-codex-meta/.test(line)) {
      entries.push({ startLine: ln, endLine: ln, reason: "script filename" });
      continue;
    }

    // "Codex CLI" — tool product name, not reviewer identity
    if (/Codex CLI/.test(line)) {
      entries.push({ startLine: ln, endLine: ln, reason: "product name (Codex CLI)" });
      continue;
    }

    // "inside Codex" — describes runtime environment, not provider identity
    if (/inside Codex/.test(line) || /via Codex/.test(line)) {
      entries.push({ startLine: ln, endLine: ln, reason: "runtime environment description" });
      continue;
    }
  }

  return entries;
}

describe("3rd-review provider-name scan", () => {
  test("SKILL.md exists", () => {
    expect(require("node:fs").existsSync(SKILL_MD)).toBe(true);
  });

  test("T025: zero provider-name violations (allowlist exempted)", () => {
    const content = readFileSync(SKILL_MD, "utf-8");
    const lines = content.split("\n");
    const allowlist = buildAllowlist(content);
    const allowedLines = new Set<number>();
    for (const entry of allowlist) {
      for (let ln = entry.startLine; ln <= entry.endLine; ln++) {
        allowedLines.add(ln);
      }
    }

    // Scan for provider-name patterns: "codex" or "Codex" (case-sensitive,
    // word-boundary to avoid matching substrings like "codexec").
    // We look for "Codex" (capital C) as proper noun, and "codex" (lowercase)
    // when used as an identity token outside allowlisted contexts.
    const violations: { line: number; text: string; reason: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1;
      if (allowedLines.has(ln)) continue;

      const line = lines[i]!;

      // Skip code blocks (```...```) — these contain shell examples
      // We detect code-block boundaries but only exclude the content inside them
      // Actually, we count ALL lines including code blocks, because a code block
      // containing `codex-companion.mjs` IS a violation. The allowlist handles
      // legitimate code-block lines.

      // "Codex" as proper noun (capital C, standalone word)
      if (/\bCodex\b/.test(line)) {
        violations.push({
          line: ln,
          text: line.trim().substring(0, 80),
          reason: '"Codex" used as proper noun (provider identity)',
        });
      }

      // "codex" lowercase in prose context (not in allowlisted path/var/tool patterns)
      // We only flag lowercase "codex" when it appears as a standalone word
      // that isn't part of an allowlisted pattern
      if (/\bcodex\b/.test(line) && !/codex exec|codex login|command codex|@openai\/codex|extract-codex-meta|codex \/ claude/.test(line)) {
        violations.push({
          line: ln,
          text: line.trim().substring(0, 80),
          reason: '"codex" used in prose (potential provider identity)',
        });
      }

      // "codex-companion" — old tool reference that must be removed
      if (/codex-companion/.test(line)) {
        violations.push({
          line: ln,
          text: line.trim().substring(0, 80),
          reason: '"codex-companion" old tool reference (must use codex exec)',
        });
      }

      // "CODEX_" prefix env vars (not CODEX_SKILLS which is allowlisted)
      if (/CODEX_(?!SKILLS|REVIEW_TIMEOUT)/.test(line)) {
        violations.push({
          line: ln,
          text: line.trim().substring(0, 80),
          reason: 'CODEX_ env var (provider-specific, not allowlisted)',
        });
      }
    }

    if (violations.length > 0) {
      console.error(
        `\nFound ${violations.length} provider-name violation(s):\n` +
          violations
            .map((v) => `  Line ${v.line}: [${v.reason}] ${v.text}`)
            .join("\n")
      );
    }

    expect(violations).toHaveLength(0);
  });

  test("T025: no source:codex journal identity in SKILL.md", () => {
    const content = readFileSync(SKILL_MD, "utf-8");
    // Journal source field must use "reviewer" not "codex" as provider identity
    expect(content).not.toMatch(/"source":\s*"codex"/);
    expect(content).not.toMatch(/'source':\s*'codex'/);
  });

  test("T026: adapter probe-env outputs eval-safe AVAILABLE_REVIEWERS assignment", () => {
    const adapterPath = path.join(here, "../../harness/review-dispatch-adapter.sh");
    const content = readFileSync(adapterPath, "utf-8");
    // probe-env subcommand must output shell-eval-safe AVAILABLE_REVIEWERS= assignment
    // so SKILL.md can eval "$(bash review-dispatch-adapter.sh probe-env)" to get env probe result
    expect(content).toMatch(/probe-env\)/);
    expect(content).toMatch(/AVAILABLE_REVIEWERS=/);
    // The probe-env block must NOT use CODEX_VERSION or provider-specific env var names
    const probeEnvMatch = content.match(/probe-env\)([\s\S]*?);;/);
    if (probeEnvMatch) {
      const probeBlock = probeEnvMatch[1];
      expect(probeBlock).not.toMatch(/CODEX_VERSION/);
    }
  });

  test("T027: adapter probe-env probes both claude and codex CLIs (D1 env_probe multi-cli)", () => {
    const adapterPath = path.join(here, "../../harness/review-dispatch-adapter.sh");
    const content = readFileSync(adapterPath, "utf-8");
    // D1 requires probing "优先判 claude code / codex" — both must be present in probe-env block
    const probeEnvMatch = content.match(/probe-env\)([\s\S]*?);;/);
    expect(probeEnvMatch).not.toBeNull();
    if (probeEnvMatch) {
      const probeBlock = probeEnvMatch[1];
      // Must probe claude CLI
      expect(probeBlock).toMatch(/command claude/);
      // Must probe codex CLI
      expect(probeBlock).toMatch(/command codex/);
    }
    // exec subcommand must also probe both CLIs
    const execMatch = content.match(/exec\)([\s\S]*?)# Auto-route/);
    if (execMatch) {
      const execBlock = execMatch[1];
      expect(execBlock).toMatch(/command claude/);
      expect(execBlock).toMatch(/command codex/);
    }
  });

  test("T028: adapter probe-env output is eval-safe (uses printf %q, not single-quote wrapping)", () => {
    const adapterPath = path.join(here, "../../harness/review-dispatch-adapter.sh");
    const content = readFileSync(adapterPath, "utf-8");
    // The probe-env block must use printf %q for shell-safe assignment, not echo "VAR='$VAR'"
    // echo "VAR='$VAR'" is NOT eval-safe when the value contains a single quote
    const probeEnvMatch = content.match(/probe-env\)([\s\S]*?);;/);
    expect(probeEnvMatch).not.toBeNull();
    if (probeEnvMatch) {
      const probeBlock = probeEnvMatch[1];
      // Must use printf %q for eval-safe output
      expect(probeBlock).toMatch(/printf.*%q/);
      // Must NOT use the unsafe single-quote-wrapping pattern
      expect(probeBlock).not.toMatch(/echo "AVAILABLE_REVIEWERS='\$AVAILABLE_REVIEWERS'"/);
    }
  });

  // D10 (FR-SLIM-002) T029/T030/T031 断言迁移：动态升级规则 + provenance 枚举从
  // SKILL.md 薄壳移入 references/。断言改读 references/ 新位置（禁止两套断言并存，
  // 禁止往薄壳塞关键字让旧断言假绿）。
  test("T029: dynamic escalation rule (连续 4 轮 → escalate) lives in references/verdict-dispatch.md with no fixed round cap (FR-REVIEW-011, D10 slim)", () => {
    const refPath = path.join(here, "references", "verdict-dispatch.md");
    const content = readFileSync(refPath, "utf-8");
    // Must contain the 4-round-same-finding escalation rule (moved out of SKILL.md shell)
    expect(content).toMatch(/连续 4 轮/);
    // Must NOT have a fixed round cap
    expect(content).not.toMatch(/最多.*轮/);
    expect(content).not.toMatch(/轮次上限/);
    expect(content).not.toMatch(/max.*round/i);
    // Must NOT delegate to VerdictRouter (skill-layer decision, not engine layer)
    expect(content).not.toMatch(/VerdictRouter/);
    // Anti-false-green: the literal must NOT remain verbatim in the slimmed SKILL.md shell
    const shell = readFileSync(path.join(here, "SKILL.md"), "utf-8");
    expect(shell).not.toMatch(/连续 4 轮/);
  });

  test("T030: dynamic escalation section in references/verdict-dispatch.md cross-references hard-guard constraint (FR-REVIEW-004) (T007, D10 slim)", () => {
    const refPath = path.join(here, "references", "verdict-dispatch.md");
    const content = readFileSync(refPath, "utf-8");
    // The dynamic escalation context must reference hard-guard / FR-REVIEW-004
    const escalationMatch = content.match(/动态升级([\s\S]{0,500})/);
    expect(escalationMatch).not.toBeNull();
    if (escalationMatch) {
      const escalationContext = escalationMatch[1] ?? "";
      const hasHardGuardRef = /硬护栏|FR-REVIEW-004/.test(escalationContext);
      expect(hasHardGuardRef).toBe(true);
    }
    // Anti-false-green: FR-REVIEW-004 must NOT remain verbatim in the slimmed shell
    const shell = readFileSync(path.join(here, "SKILL.md"), "utf-8");
    expect(shell).not.toMatch(/FR-REVIEW-004/);
  });

  test("T031: clean-context subagent provenance enum lives in references/reviewer-prompt-assembly.md with schema-valid value (FR-REVIEW-003, D10 slim)", () => {
    // verdict.schema.json enum: ["single-context", "independent-subagent", "independent-session"]
    // "subagent-clean-context" is NOT a valid enum value — must use "independent-subagent"
    const refPath = path.join(here, "references", "reviewer-prompt-assembly.md");
    const content = readFileSync(refPath, "utf-8");
    expect(content).not.toMatch(/subagent-clean-context/);
    expect(content).toMatch(/independent-subagent/);
    // Anti-false-green: the enum literal must NOT remain verbatim in the slimmed shell
    const shell = readFileSync(path.join(here, "SKILL.md"), "utf-8");
    expect(shell).not.toMatch(/independent-subagent/);
  });

  test("T032: adapter.sh FR-REVIEW-003 routing uses AVAILABLE_REVIEWERS (not command -v claude re-check) (FR-REVIEW-003)", () => {
    // Bug: using "command -v claude" re-runs CLI detection after PATH may have changed,
    // which fails in the same scenario that triggered no_external_cli.
    // Fix: check AVAILABLE_REVIEWERS (set by env_probe) instead.
    const adapterPath = path.join(
      here,
      "../../harness/review-dispatch-adapter.sh"
    );
    const content = readFileSync(adapterPath, "utf-8");
    // Must not use "command -v claude" as the routing condition for FR-REVIEW-003 fallback
    expect(content).not.toMatch(/command -v claude/);
    // Must use AVAILABLE_REVIEWERS to detect claude availability
    const fr003Block = content.match(
      /FR-REVIEW-003([\s\S]{0,600})/
    );
    expect(fr003Block).not.toBeNull();
    if (fr003Block) {
      expect(fr003Block[1]).toMatch(/AVAILABLE_REVIEWERS/);
    }
  });

  test("T033: adapter.sh FR-REVIEW-003 grep uses -F (fixed-string) not POSIX BRE \\b word boundary (macOS compat) (FR-REVIEW-003)", () => {
    // Bug: grep -q "\bcodex:" uses POSIX BRE \b word boundary, which is not supported on
    // macOS BSD grep — the routing condition silently never matches on macOS, causing
    // FR-REVIEW-003 fallback to silently fail even when AVAILABLE_REVIEWERS contains claude.
    // Fix: use grep -qF "codex:" (fixed-string, portable).
    const adapterPath = path.join(
      here,
      "../../harness/review-dispatch-adapter.sh"
    );
    const content = readFileSync(adapterPath, "utf-8");
    // Must not use \b word boundary in AVAILABLE_REVIEWERS grep checks
    expect(content).not.toMatch(/grep -q "\\bcodex:/);
    expect(content).not.toMatch(/grep -q "\\bclaude:/);
    // Must use grep -qF (fixed-string) for AVAILABLE_REVIEWERS checks in exec subcommand
    expect(content).toMatch(/grep -qF "codex:/);
    expect(content).toMatch(/grep -qF "claude:/);
  });

  test("T034: adapter.sh claude provider path guards against timeout unavailability (macOS compat) (FR-REVIEW-003)", () => {
    // Bug: `timeout $REVIEW_TIMEOUT claude ...` fails when `timeout` is not in PATH
    // (e.g., macOS without coreutils at /opt/homebrew/bin/, shielded PATH in tests).
    // Fix: detect timeout availability via `command -v timeout`, skip timeout if absent.
    const adapterPath = path.join(
      here,
      "../../harness/review-dispatch-adapter.sh"
    );
    const content = readFileSync(adapterPath, "utf-8");
    // Must use _TIMEOUT_CMD variable pattern (guards against timeout not in PATH)
    expect(content).toMatch(/_TIMEOUT_CMD/);
    // Must not unconditionally call `timeout $REVIEW_TIMEOUT claude` without the guard
    expect(content).not.toMatch(/\btimeout "\$REVIEW_TIMEOUT" claude\b/);
  });

  test("T035: adapter.sh FR-REVIEW-003 fires when PROVIDER=codex-from-config but codex absent from AVAILABLE_REVIEWERS (ordering bug fix) (FR-REVIEW-003)", () => {
    // Bug: PROVIDER="${PROVIDER:-$RESOLVED_PROVIDER}" sets PROVIDER=codex from config (line ~165).
    // FR-REVIEW-003 guard only fires when PROVIDER is empty → guard always bypassed in normal execution
    // (node present, config resolves, PROVIDER=codex before guard runs).
    // Fix: track EXPLICIT_PROVIDER flag at --provider= arg parse; before FR-REVIEW-003 guard,
    // if PROVIDER=codex and it was NOT set explicitly and codex is not in AVAILABLE_REVIEWERS,
    // clear PROVIDER so FR-REVIEW-003 guard fires.
    const adapterPath = path.join(
      here,
      "../../harness/review-dispatch-adapter.sh"
    );
    const content = readFileSync(adapterPath, "utf-8");
    // Must track explicit provider flag at --provider= parse site
    expect(content).toMatch(/EXPLICIT_PROVIDER/);
    // FR-REVIEW-003 block must handle the case where PROVIDER was set from config (not explicit)
    // but the configured provider is not in AVAILABLE_REVIEWERS — clear PROVIDER before the guard
    const fr003Block = content.match(/FR-REVIEW-003([\s\S]{0,1200})/);
    expect(fr003Block).not.toBeNull();
    if (fr003Block) {
      const block = fr003Block[1];
      // Must clear PROVIDER (or equivalent) when config-defaulted provider not in AVAILABLE_REVIEWERS
      expect(block).toMatch(/EXPLICIT_PROVIDER/);
    }
  });

  test("T036: SKILL.md 调用面 uses 'review' subcommand (one-step thick wrapper) not separate exec+persist (FR-REVIEW-008/T009)", () => {
    // T009: thick calling interface — orchestrator uses single `review` subcommand,
    // not two separate exec + persist calls. SKILL.md must reference `review` subcommand
    // as the canonical invocation and must NOT instruct separate exec then persist.
    const skillPath = path.join(here, "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    // Must reference the `review` subcommand as the thick wrapper call
    expect(content).toMatch(/review-dispatch-adapter\.sh\s+review/);
    // Must NOT instruct "exec then persist" as separate sequential steps
    expect(content).not.toMatch(/先 ?exec.*再 ?persist/);
    expect(content).not.toMatch(/exec 后.*persist/);
  });

  test("T037: adapter.sh review subcommand outputs three-tuple JSON on success (verdict + reportPath + evidencePaths) (FR-REVIEW-009/T010)", () => {
    // T010: review subcommand must output the three-tuple on success so the orchestrator
    // can jq .verdict / .reportPath / .evidencePaths without reading separate files.
    // Also: on failure it must output {"verdict":"failed",...} and exit 0 (not crash).
    const adapterPath = path.join(here, "../../harness/review-dispatch-adapter.sh");
    const content = readFileSync(adapterPath, "utf-8");
    // Success path: emit three-tuple JSON with verdict + reportPath + evidencePaths
    expect(content).toMatch(/"reportPath"/);
    expect(content).toMatch(/"evidencePaths"/);
    // Failure path: emit {"verdict":"failed",...} and exit 0 (not exit 2)
    expect(content).toMatch(/verdict.*failed/);
    // The review section must exit 0 on exec/persist failures (not crash with exit 2)
    const reviewIdx = content.indexOf("  review)");
    const persistIdx = content.indexOf("  persist)");
    const reviewSection = content.slice(reviewIdx, persistIdx);
    expect(reviewSection).toMatch(/exit 0/);
    expect(reviewSection).not.toMatch(/exec failed[\s\S]{0,20}exit 2/);
  });

  test("T038: SKILL.md exec+persist two-step prose replaced by single-step 'review' invocation (FR-REVIEW-010/T011)", () => {
    // T011: SKILL.md must describe the invocation as a single step —
    // "结果确认后直接生成报告" (one-step). The old two-step phrasing
    // (exec block then separate persist block as Step 4 + Step 5) must be collapsed.
    const skillPath = path.join(here, "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    // Must not have "Step 5" as a separate persist step after exec
    expect(content).not.toMatch(/步骤[\s\S]{0,20}5[\s\S]{0,50}persist/);
    // Must reference the atomic review command
    expect(content).toMatch(/review-dispatch-adapter\.sh\s+review/);
  });

  test("T_QUALITY_002: FR-QUALITY-002 产物落盘可靠 — adapter.sh 产物非空校验 + 落盘失败返回 failed + route-review.mjs --out 真实落盘 (Phase 1 同源子代理质量)", async () => {
    const adapterPath = path.join(here, "../../harness/review-dispatch-adapter.sh");
    const adapterContent = readFileSync(adapterPath, "utf-8");

    // ── (a) 产物路径声明 ──
    // adapter.sh review 子命令成功路径必须同时输出 reportPath 和 evidencePaths
    expect(adapterContent).toMatch(/"reportPath"/);
    expect(adapterContent).toMatch(/"evidencePaths"/);

    // ── (b) 落盘失败 → failed 语义（行为级，可证伪）──
    // FR-QUALITY-002：adapter 必须在输出三元组前校验产物文件「存在且非空」，
    // 且必须按 review-persist.sh 实际写入的 source-derived 路径解析产物位置，
    // 而非写死 flat ${task-dir}/reviews。后者在 source-derived 布局下读错位置，
    // 把每次成功 persist 误判为「产物缺失」失败。
    //
    // 真跑 adapter 的 _verify-artifact seam（review 子命令落盘校验的真实代码），
    // 用带 source-derived marker 的受控 fixture 跑两态：
    //   present → 产物在 .machine/source/reviews/ → 成功三元组（verdict 来自产物）
    //   absent  → 无产物 → verdict:"failed"
    // 此断言对「写死 flat 路径」的旧实现为 RED（present 态产物在 source，旧代码查
    // flat 空目录 → 误判 failed），故可证伪、非 grep 占位。
    {
      const { execSync } = await import("node:child_process");
      const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const taskDir = mkdtempSync(path.join(tmpdir(), "t-quality-002-seam-"));
      // source-derived layout marker (storage-layout.ts detectLayout)
      mkdirSync(path.join(taskDir, ".machine"), { recursive: true });
      writeFileSync(path.join(taskDir, ".machine", "layout-version.json"), '{"version":1}');
      const cp = "code-review-phase-1";
      // present: write real artifact under source-derived location
      const srcReviews = path.join(taskDir, ".machine", "source", "reviews", cp);
      mkdirSync(srcReviews, { recursive: true });
      writeFileSync(path.join(srcReviews, "round-1.json"), '{"verdict":"pass"}');

      const runVerify = (round: number): any => {
        const out = execSync(
          `bash ${JSON.stringify(adapterPath)} _verify-artifact --checkpoint-id=${cp} --round=${round} --task-dir=${JSON.stringify(taskDir)}`,
          { timeout: 30000 }
        ).toString();
        return JSON.parse(out.trim());
      };

      // present → success tuple, verdict resolved from the source-derived artifact
      const present = runVerify(1);
      expect(present.verdict).toBe("pass");
      expect(present.evidencePaths[0]).toContain(".machine/source/reviews");
      // absent → failed semantics (round 2 has no artifact)
      const absent = runVerify(2);
      expect(absent.verdict).toBe("failed");
      expect(absent.error).toMatch(/missing or empty/);
    }

    // ── (c) 行为级产物落盘：真跑 route-review.mjs --out=<tmpfile> ──
    const { execSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync: readFs, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "t-quality-002-"));
    const outFile = path.join(tmpDir, "route-decision.json");
    const routeMjsPath = path.join(here, "../../harness/../skills/3rd-review/scripts/route-review.mjs");
    // Pipe minimal input (empty design text) to route-review.mjs and request --out
    execSync(
      `echo "design spec content" | node ${JSON.stringify(routeMjsPath)} --input=- --out=${JSON.stringify(outFile)}`,
      { timeout: 10000 }
    );
    // Must write the file
    expect(existsSync(outFile)).toBe(true);
    // Must be non-empty
    const raw = readFs(outFile, "utf-8");
    expect(raw.trim().length).toBeGreaterThan(0);
    // Must be valid JSON containing cleanContextRequired
    const parsed = JSON.parse(raw);
    expect(typeof parsed.cleanContextRequired).toBe("boolean");
  });

  test("T_QUALITY_001: enforceCleanContext exported from route-review.mjs and adapter.sh reads cleanContextRequired to enforce isolation (Phase 1 同源子代理质量)", async () => {
    // ── Part A: adapter.sh must read cleanContextRequired and wire it to isolation params ──
    const adapterPath = path.join(here, "../../harness/review-dispatch-adapter.sh");
    const adapterContent = readFileSync(adapterPath, "utf-8");

    // A1: cleanContextRequired must appear in a real read/conditional context —
    // i.e., used in a jq/grep extraction or an if/case branch — not just in a comment.
    // The regex requires the field name immediately followed by (or preceded by)
    // a shell read/conditional operator, ruling out bare comment mentions.
    expect(adapterContent).toMatch(
      /(?:jq[^'"\n]*['"]\.cleanContextRequired|grep[^'\n]*cleanContextRequired|cleanContextRequired[^'"\n]*\|\s*jq|if\s*\[.*cleanContextRequired|\$\{?CLEAN_CONTEXT_REQUIRED\}?)/
    );

    // A2: the field must be connected to an isolation action —
    // when cleanContextRequired is truthy, --no-context or the ISOLATED_PROMPT_FILE mechanism
    // must be triggered. The regex requires CLEAN_CONTEXT_REQUIRED or cleanContextRequired
    // appearing in close proximity (same logical block) to no-context or ISOLATED_PROMPT_FILE.
    expect(adapterContent).toMatch(
      /CLEAN_CONTEXT_REQUIRED[\s\S]{0,400}(?:--no-context|ISOLATED_PROMPT_FILE)|(?:--no-context|ISOLATED_PROMPT_FILE)[\s\S]{0,400}CLEAN_CONTEXT_REQUIRED/
    );

    // ── Part B: route-review.mjs must export enforceCleanContext as a function ──
    const routeMjsPath = path.join(here, "../../harness/../skills/3rd-review/scripts/route-review.mjs");
    // Dynamic ESM import — the function does not exist yet so this will fail (RED)
    const mod = await import(routeMjsPath) as Record<string, unknown>;

    // B1: enforceCleanContext must be exported
    expect(typeof mod.enforceCleanContext).toBe("function");

    // B2 (behaviour): routeDecision without cleanContext flag → cleanContextRequired forced true
    const enforceCleanContext = mod.enforceCleanContext as (decision: Record<string, unknown>) => Record<string, unknown>;
    const resultNoFlag = enforceCleanContext({});
    expect(resultNoFlag.cleanContextRequired).toBe(true);

    // B3 (behaviour): routeDecision already carrying cleanContext:true → no force needed
    const resultWithFlag = enforceCleanContext({ cleanContext: true });
    expect(resultWithFlag.cleanContextRequired).not.toBe(true);
  });
});

// ── Phase 4 (P4): finding-class — blockerClass enum + AJV illegal-combination guard ──
// Authoritative ruling (decision-log D6 + spec FR-CLASS-004 L213): the solution is
// PREVENTION at the review stage — the schema must REJECT the illegal combination
// (process_evidence + blocking), forcing the reviewer to classify correctly up front.
// We do NOT build a downgrade-transform (would be unrequested scope; karpathy 铁律 1).
// spec FR-CLASS-002 "降为 important" is end-state intent language, machine-enforced by
// rejecting the blocking form so a process_evidence finding can never exist as blocking.
//
// blockerClass enum (verbatim spec L200/L323): delivery_quality / process_evidence / output_contract
// FR-CLASS-001 (L200/L367): blockerClass is REQUIRED; missing → fail-fast (not default-downgrade).
// FR-CLASS-002 (L204): process_evidence + blocking → rejected; delivery_quality + blocking → kept.
// The AJV constraint must forbid ONLY the combination, never the whole class
// (process_evidence + important/minor stays legal — advisor blind-spot guard).
// Scope (resolved against schema reality): the constraint lands ONLY in the two
// schemas that carry a real finding object with a severity — verdict.schema.json
// and verifier-report.schema.json. review-fixes.schema.json is EXCLUDED: it has no
// findings/severity (it records the main agent's fix log: planned/fixed), so the
// forbidden combination (process_evidence + blocking) is structurally meaningless
// there, no FR requires it, and no gate reads it (gate work lives on the
// reviewer_output→verdict path, not checkpoint_request→review-fixes). Adding an
// unused field there would be an orphan deliverable. tasks.md Task 10 over-listed
// three schemas; the exclusion is asserted explicitly below so it is traceable,
// not silent. (decision-log: see FR-CLASS scope note.)
describe("finding-class: blockerClass enum + AJV illegal-combination guard (FR-CLASS-001/002/003)", () => {
  const fixturesDir = path.join(here, "__fixtures__");
  const schemasDir = path.join(here, "..", "..", "schemas");
  const FINDING_SCHEMAS = [
    "verdict.schema.json",
    "verifier-report.schema.json",
  ];

  // Compile a schema with Ajv and return a validator over a single finding object,
  // by pointing Ajv at the finding-items subschema if present, else validating the
  // whole document. We validate findings directly so the same fixtures exercise all
  // three schemas regardless of their top-level document shape.
  async function makeFindingValidator(schemaFile: string) {
    const AjvMod = await import("ajv");
    const Ajv = (AjvMod.default ?? AjvMod) as unknown as new (opts?: Record<string, unknown>) => {
      compile: (s: unknown) => (d: unknown) => boolean;
    };
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schema = JSON.parse(readFileSync(path.join(schemasDir, schemaFile), "utf8"));
    // Extract the finding-item subschema. Each schema embeds the finding object
    // under findings.items (verdict / verifier-report) or fixesFindings/findings.items
    // (review-fixes). We locate the first object subschema that constrains "severity".
    const findingItems = locateFindingItemsSchema(schema);
    expect(findingItems, `${schemaFile} must contain a finding-item subschema`).toBeTruthy();
    return ajv.compile(findingItems);
  }

  // Walk the schema to find the finding-item object subschema (the one whose
  // properties include both "severity" and "blockerClass" once P4 lands).
  function locateFindingItemsSchema(node: unknown): Record<string, unknown> | null {
    if (!node || typeof node !== "object") return null;
    const obj = node as Record<string, unknown>;
    const props = obj.properties as Record<string, unknown> | undefined;
    if (props && "severity" in props) return obj;
    for (const v of Object.values(obj)) {
      const found = locateFindingItemsSchema(v);
      if (found) return found;
    }
    return null;
  }

  function loadFixtureFinding(name: string): Record<string, unknown> {
    const doc = JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
    return doc.findings[0];
  }

  test("T_CLASS_001: process_evidence + blocking is REJECTED by every schema (illegal combination)", async () => {
    const illegal = loadFixtureFinding("finding-class-illegal.json");
    for (const schemaFile of FINDING_SCHEMAS) {
      const validate = await makeFindingValidator(schemaFile);
      expect(validate(illegal), `${schemaFile} must reject process_evidence+blocking`).toBe(false);
    }
  });

  test("T_CLASS_002: delivery_quality + blocking is LEGAL (kept) in every schema", async () => {
    const legal = loadFixtureFinding("finding-class-legal.json");
    for (const schemaFile of FINDING_SCHEMAS) {
      const validate = await makeFindingValidator(schemaFile);
      expect(validate(legal), `${schemaFile} must accept delivery_quality+blocking`).toBe(true);
    }
  });

  test("T_CLASS_003: missing blockerClass is REJECTED (required → fail-fast, not default-downgrade)", async () => {
    const missing = loadFixtureFinding("finding-class-missing.json");
    for (const schemaFile of FINDING_SCHEMAS) {
      const validate = await makeFindingValidator(schemaFile);
      const ok = validate(missing);
      expect(ok, `${schemaFile} must reject a finding with no blockerClass`).toBe(false);
    }
  });

  test("T_CLASS_004: constraint forbids ONLY the combination, not the class — process_evidence+important is LEGAL", async () => {
    const procImp = loadFixtureFinding("finding-class-process-important.json");
    for (const schemaFile of FINDING_SCHEMAS) {
      const validate = await makeFindingValidator(schemaFile);
      expect(validate(procImp), `${schemaFile} must accept process_evidence+important`).toBe(true);
    }
  });

  test("T_CLASS_005: output_contract may be blocking (视严重程度) — legal in every schema", async () => {
    const outBlock = loadFixtureFinding("finding-class-output-blocking.json");
    for (const schemaFile of FINDING_SCHEMAS) {
      const validate = await makeFindingValidator(schemaFile);
      expect(validate(outBlock), `${schemaFile} must accept output_contract+blocking`).toBe(true);
    }
  });

  test("T_CLASS_006: blockerClass enum is exactly the three D6 values in every schema", async () => {
    for (const schemaFile of FINDING_SCHEMAS) {
      const schema = JSON.parse(readFileSync(path.join(schemasDir, schemaFile), "utf8"));
      const findingItems = locateFindingItemsSchema(schema) as Record<string, unknown> | null;
      expect(findingItems, `${schemaFile} must have a finding-item subschema`).toBeTruthy();
      const props = (findingItems!.properties ?? {}) as Record<string, { enum?: string[] }>;
      const bc = props.blockerClass;
      expect(bc, `${schemaFile} finding must declare blockerClass`).toBeTruthy();
      expect(new Set(bc!.enum)).toEqual(
        new Set(["delivery_quality", "process_evidence", "output_contract"]),
      );
      const required = (findingItems!.required ?? []) as string[];
      expect(required, `${schemaFile} finding must require blockerClass`).toContain("blockerClass");
    }
  });

  test("T_CLASS_007: review-fixes.schema.json is EXCLUDED — it has no finding-item subschema (traceable exclusion, not silent skip)", () => {
    const schema = JSON.parse(
      readFileSync(path.join(schemasDir, "review-fixes.schema.json"), "utf8"),
    );
    // review-fixes records the main agent's fix log (planned/fixed); it has no
    // findings array and no severity, so the FR-CLASS forbidden-combination is
    // structurally meaningless here. Assert there is no finding-item subschema so
    // the exclusion is tested + documented rather than silently skipped.
    const findingItems = locateFindingItemsSchema(schema);
    expect(findingItems, "review-fixes must NOT carry a finding-item subschema").toBeNull();
  });
});

// ── P6 (FR-FAST / FR-TRACE): --fast 同源快出 + route_decision 持久化 ──
describe("P6 --fast mode + route-decision-history persistence (FR-FAST-001/002, FR-TRACE-001)", () => {
  const adapterPath = path.join(here, "../../harness/review-dispatch-adapter.sh");
  const routeMjsPath = path.join(
    here,
    "../../harness/../skills/3rd-review/scripts/route-review.mjs",
  );

  test("T_FAST_001: --fast forces same_source_subagent even on an input that otherwise routes cross-source (FR-FAST-001)", async () => {
    // Contrast input: a code-diff with a risk keyword (migration) → scope=large →
    // cross_source_with_subagent WITHOUT --fast. --fast must flip it to R6. A pure-doc
    // input would route R6 either way (vacuous); this contrast proves --fast does work.
    const mod = (await import(routeMjsPath)) as Record<string, unknown>;
    const routeReview = mod.routeReview as (
      args: Record<string, unknown>,
    ) => Record<string, unknown>;
    const crossSourceInput = "diff --git a/migration.sql b/migration.sql\n@@ migration token @@";

    // Baseline (no --fast): the same input must NOT be same_source_subagent,
    // otherwise the contrast is vacuous and the test proves nothing.
    const baseline = routeReview({ input: crossSourceInput, diffLines: 50 });
    expect(baseline.level).not.toBe("same_source_subagent");

    // --fast: short-circuit to same_source_subagent (R6), skipping the 三步判定.
    const fast = routeReview({ input: crossSourceInput, diffLines: 50, fast: true });
    expect(fast.level).toBe("same_source_subagent");
    expect(String(fast.basis)).toMatch(/fast/i);

    // CLI form: bare `--fast` flag (not --fast=...) must be parsed and produce R6.
    const { execSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync: readFs } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "t-fast-001-"));
    const outFile = path.join(tmpDir, "rd.json");
    execSync(
      `printf %s ${JSON.stringify(crossSourceInput)} | node ${JSON.stringify(routeMjsPath)} --input=- --diff-lines=50 --fast --out=${JSON.stringify(outFile)}`,
      { timeout: 10000 },
    );
    const cliDecision = JSON.parse(readFs(outFile, "utf-8"));
    expect(cliDecision.level).toBe("same_source_subagent");
  });

  test("T_TRACE_002: countExternalCodex counts codex subreviewers via subreviewerRuntimeReports sessionFile + final reviewer, on the REAL adapter-passed bundle shape (验收维度A 数据源)", async () => {
    // The count must come from the SHAPE the adapter actually passes (DELEGATED_BUNDLE_FILE,
    // run-delegated-precheck.mjs L1662-1672: subreviewerRuntimeReports at TOP LEVEL, reports[]
    // carries NO provider field). A codex subreviewer is identified by sessionFile under
    // /.codex/ — the positive codex-dispatch signal — NOT by reports[].provider (never exists
    // on the real bundle → would collapse to final-only=1) and NOT by array length (claude
    // FR-REVIEW-003 fallback subreviewers also appear here, without a /.codex/ sessionFile).
    const mod = (await import(routeMjsPath)) as Record<string, unknown>;
    const countExternalCodex = mod.countExternalCodex as (
      bundle: Record<string, unknown>,
      finalReviewerProvider: string,
    ) => number;
    expect(typeof countExternalCodex).toBe("function");

    // (a) Real adapter shape: 6 codex subreviewers (sessionFile under /.codex/sessions/) + codex final.
    const realBundle = {
      bundle: { mode: "delegated", topRisks: [], candidateFindings: [] },
      reports: [], // real precheck reports[] carries no provider — must be ignored
      subreviewerRuntimeReports: [
        { name: "source-manifest-auditor", sessionModel: "gpt-5.5", sessionFile: "/Users/x/.codex/sessions/2026/06/16/rollout-a.jsonl" },
        { name: "required-skill-auditor", sessionModel: "gpt-5.5", sessionFile: "/Users/x/.codex/sessions/2026/06/16/rollout-b.jsonl" },
        { name: "scope-boundary-auditor", sessionModel: "gpt-5.5", sessionFile: "/Users/x/.codex/sessions/2026/06/16/rollout-c.jsonl" },
        { name: "evidence-freshness-auditor", sessionModel: "gpt-5.5", sessionFile: "/Users/x/.codex/sessions/2026/06/16/rollout-d.jsonl" },
        { name: "mechanical-grep-auditor", sessionModel: "gpt-5.5", sessionFile: "/Users/x/.codex/sessions/2026/06/16/rollout-e.jsonl" },
        { name: "verifier-closure-auditor", sessionModel: "gpt-5.5", sessionFile: "/Users/x/.codex/sessions/2026/06/16/rollout-f.jsonl" },
      ],
    };
    // 6 codex subreviewers + 1 codex final reviewer = 7 (NOT 1 — final-only collapse is the bug)
    expect(countExternalCodex(realBundle, "codex")).toBe(7);
    // claude final reviewer → no +1 → 6
    expect(countExternalCodex(realBundle, "claude")).toBe(6);

    // (b) MUTATION-KILLER: subreviewers present but sessionFile NOT under /.codex/ (resultFile
    // fallback — codex meta-extract failure OR claude FR-REVIEW-003 subagent). These must NOT
    // be counted as codex. A count=length impl would wrongly return 3 here.
    const degradedBundle = {
      subreviewerRuntimeReports: [
        { name: "a", sessionFile: "/tmp/review-delegated-precheck-x/a.result.json" },
        { name: "b", sessionFile: "/tmp/review-delegated-precheck-x/b.result.json" },
        { name: "c", sessionModel: null, sessionFile: "/tmp/review-delegated-precheck-x/c.result.json" },
      ],
    };
    // zero codex subreviewers (none under /.codex/) + claude final = 0
    expect(countExternalCodex(degradedBundle, "claude")).toBe(0);
    // codex final reviewer still adds its own +1
    expect(countExternalCodex(degradedBundle, "codex")).toBe(1);

    // (c) Fast path: empty subreviewers + claude final = 0.
    expect(countExternalCodex({ subreviewerRuntimeReports: [] }, "claude")).toBe(0);

    // (d) Nested fallback (staged.raw / delegatedReviewBundle nesting) resolves the same.
    const nestedBundle = {
      delegatedReviewBundle: {
        subreviewerRuntimeReports: [
          { name: "a", sessionFile: "/Users/x/.codex/sessions/2026/06/16/r.jsonl" },
        ],
      },
    };
    expect(countExternalCodex(nestedBundle, "codex")).toBe(2);

    // integer type (验收维度A is a strict-decrease numeric comparison)
    expect(Number.isInteger(countExternalCodex(realBundle, "codex"))).toBe(true);
  });

  test("T_TRACE_001: adapter parses --fast, bypasses same-host guard + codex, and persists route-decision-history.jsonl with externalCodexCount (FR-TRACE-001, FR-FAST-001)", () => {
    const content = readFileSync(adapterPath, "utf-8");

    // (a) --fast is parsed in the arg case block.
    expect(content).toMatch(/--fast\)\s*FAST=1/);

    // (b) --fast forces the same-source (claude) path so NO external codex launches.
    expect(content).toMatch(/FAST.*=.*1.*PROVIDER=claude|FAST.*PROVIDER=claude/s);

    // (c) The same-host anti-self-review guard MUST be bypassed under --fast — else
    // PROVIDER=claude under Claude Code flips back to codex (L262) or exits (L266),
    // re-launching external codex and violating standard 4 "全程不调用外部 codex".
    // Assert the guard condition is gated on FAST != 1.
    expect(content).toMatch(/FAST.*!=.*1|"\$FAST"\s*!=\s*"1"/);

    // (d) route-decision-history.jsonl is persisted to the task dir (append mode),
    // replacing the mktemp-用后即删 behavior. Not just a temp route file.
    expect(content).toMatch(/route-decision-history\.jsonl/);

    // (e) the persisted record carries externalCodexCount + reviewRound.
    expect(content).toMatch(/externalCodexCount/);
    expect(content).toMatch(/reviewRound/);

    // (f) write failure must not break the review (|| true tolerance near the write).
    const histIdx = content.indexOf("route-decision-history.jsonl");
    const around = content.slice(histIdx - 600, histIdx + 600);
    expect(around).toMatch(/\|\|\s*true/);
  });

  // ── D10 (FR-SLIM-002 / 验收标准5) 总读取量验证 ──────────────────────────
  // 防"单文件小了但总量没降"：主会话读取清单 = 薄壳 SKILL.md + §6 move-map 标 K
  // 的 references 子集。本次拆分把 9 个 references 全部标 M（脚本/子代理按需读，不进
  // 主会话上下文），故主会话读取清单 = 薄壳 SKILL.md 本身，无 K 类 references。
  // 断言改造后主会话读取总字节 < 改造前基线 42528（瘦身前 SKILL.md 体积）。
  test("T_SLIM_TOTAL_001: D10 slim — main-session read bytes (shell + K-class references) below the 42528 baseline", () => {
    const BASELINE_BYTES = 42528;
    // K-class references entering the main session — empty for this slim (all 9 are M).
    const K_CLASS_REFERENCES: string[] = [];
    const mainSessionReadList = [SKILL_MD, ...K_CLASS_REFERENCES.map((f) =>
      path.join(here, "references", f)
    )];
    let totalBytes = 0;
    for (const p of mainSessionReadList) {
      totalBytes += Buffer.byteLength(readFileSync(p, "utf-8"), "utf-8");
    }
    expect(totalBytes).toBeLessThan(BASELINE_BYTES);
  });
});
