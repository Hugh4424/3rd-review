# Delta Package 构造规则 + 缩范围护栏补偿 + 两层结构

> 本文件由 3rd-review SKILL.md 薄壳引用，主会话不读，审查员/脚本按需读。

## Delta Package 构造规则

**核心原则：每一轮都是完整独立审查，但完整审查不等于全文内联。** prompt 默认只内联当前 phase 关键原文、git diff、风险片段、Source Manifest 和 Required Read Set；审查方必须按 read set 读原文，必要时从 manifest 自读完整源文件；required source 不可读 → `escalate_to_human`。

- **被审对象（完整可访问，按需内联）**：design/plan 内联关键结构，完整文档进 Source Manifest；code-review 内联当前 phase tasks 段、该 phase FR 段、plan phase 段、git diff、hunk 上下文，完整文件路径进 Source Manifest；test-acceptance 内联报告结论/风险段/验收摘要，完整报告进 Source Manifest。
- **git diff（代码审查必传，替代大文件全文内联）**：第 1 轮传全部 diff；第 2+ 轮传 `git diff --stat` + 本轮 `git diff`。小文件（≤24KB）可全文内联；中等文件（24KB-80KB）内联 diff + 每个 hunk 前后 80-120 行；大文件（>80KB）禁止默认全文内联，只传 diff + hunk 上下文 + Required Read Set。无法生成 hunk 上下文/定位 changed lines/读取 manifest 文件 → 回退完整包；仍不可用 → `escalate_to_human`。
- **前轮 findings 闭合核对（仅第 2+ 轮，附加项）**：
  - 从 `reviews.jsonl` 的 `findingsSummary` 快速索引定位到对应 checkpoint + round，回读完整 raw JSON（`reviews/<checkpoint>/round-<round>.json`）
  - 禁止仅用 `findingsSummary`（丢失完整上下文）
  - **禁止在审查包里写"revision summary / 我改了哪些地方"** —— 不得向审查方预告修复内容，闭合与否由审查方独立判断
  - 闭合核对是在完整审查**之外**追加的检查，不缩小审查范围

## 无 CLI 降级形态（FR-REVIEW-003）

当 R6 因 `no_external_cli` 触发同源子代理审查时，须满足以下降级要求（route-review.mjs 只产判定，不产以下行为约束，故此节保留）：

**触发条件**：`ENV_PROBE_RESULT=no_external_cli`（两个 CLI 均探测失败）

**降级要求**：
1. **独立上下文**：通过 `Agent(subagent_type=...)` 或等效机制派发，子代理不继承主 agent 的历史对话上下文
2. **走审查合同**：子代理必须接收完整的 reviewer-contract + verifier prompt，不裸派"请审查这段代码"
3. **硬护栏不降级**：降级只影响审查员来源（外部 CLI → 内部子代理），不影响审查深度——硬护栏层全部保留（FR-REVIEW-004/005 约束不变）
4. **输出格式不变**：结果 JSON 与外部 CLI 路径一致；`provenance` 字段须使用 verdict schema 枚举值（`"single-context"` / `"independent-subagent"` / `"independent-session"`），子代理路径使用 `"independent-subagent"`
5. **验证方式**：`jq -e .verdict reviews/<cp>/round-N.json` 仍 exit 0；`jq -r .provenance reviews/<cp>/round-N.json` 应输出 `independent-subagent`

**禁止做法**：
- 不得直接用主 agent 自审（自审等于无审）
- 不得因降级省略 required skills 执行
- 不得输出不同格式绕过 gate schema 验证

## 两层结构：硬护栏层 vs 形态选择层

审查框架分为两层，两层职责不同，不可混淆：

### 硬护栏层（不可变，不可绕过）

以下约束在任何形态下均有效，任何方式选择不得绕过：

1. **最低回归覆盖**：每轮审查必须覆盖本 phase 全部 changed files 的 ≥80% 改动行
2. **强制审高风险维度**：被审对象中被标记为 high-risk 的部分必须被完整审查，不可降级为"抽查"
3. **失败回退全量**：缩范围审查（sampling / coverage exception）若任一护栏不满足 → 立即回退全量审查（`fallback_full_scope`），不得继续以缩范围方式通过
4. **独立性保证**：最终 verdict 必须由独立上下文产出，不允许主 agent 自审自判

护栏失败触发词：`fallback_full_scope` / `回退全量`（关键词，gate 可扫描）

### 形态选择层（自适应，可调整）

形态由三步评估的结果决定，包括但不限于：

- 外部 CLI 审查 vs 主 agent 子代理审查
- 单次全量 vs 分 lens 并行
- 首轮全审 vs 后轮 diff-focused

注：delegated precheck 是硬护栏（见 execution-steps.md 步骤 3.5），不属于可调形态。

形态选择不影响硬护栏层的有效性。

## 缩范围护栏补偿机制

当审查包因成本/规模原因需缩小范围时，必须满足以下补偿条件才允许继续，否则回退全量：

1. **最低回归覆盖**：缩范围后仍覆盖 ≥80% 改动行（按 git diff 行数计算）
2. **高风险维度必审**：spec 中标记 `high-risk` 的所有维度必须完整出现在审查包中
3. **任一不满足 → 回退全量**：立即终止缩范围，重新构造完整审查包

**与 Delegated Trust 的优先级**：DISPATCH OVERRIDE 中的 sampling fallback（Delegated Trust exception）只对 bundle `coverageAccepted` 列出的低风险源减少冗余重读；它不降低本轮责任域的 ≥80% 地板。高风险维度、candidate finding、forbidden/core 边界源不适用 sampling fallback。

## 动态 lens 调度（FR-LENS-001/002/003）

`inferAutomaticLensPlan` 根据审查包内容动态选择 lens，不默认启用全部 7 个。

### 配置驱动（FR-LENS-002）

触发 lens 的内容匹配模式（正则/关键词列表）统一存放在 `config/route-rules.json` 的 `lensTriggers` 节，不在代码内写死。可配置项：

- `uiKeywords` — 匹配 UI/browser 信号，触发 `browser-qa-auditor`
- `evidenceKeywords` — 匹配 apply/evidence、GREEN/RED 等，触发 `evidence-freshness-auditor`
- `mechanicalRiskKeywords` — 匹配机械风险标记，触发 `mechanical-grep-auditor`
- `sourceManifestKeywords` — 匹配 Source Manifest、Delta Package、diff --git 等，触发 `source-manifest-auditor`
- `requiredSkillKeywords` — 匹配 required skill、qa-only 等，触发 `required-skill-auditor`
- `fullFallbackOnHighRisk` (boolean) — 高风险内容时强制触发全量 lens
- `fullFallbackOnNoMatch` (boolean) — 无内容匹配时激活回退 lens（`input-contract-auditor`）

Checkpoint 前缀逻辑（`isPlan`/`isDesign`/`isTestAcceptance` 等）保留在代码中，不外化到配置。

### 强信号 v4 抑制（不可更改）

以下抑制逻辑硬编码在 `inferAutomaticLensPlan` 中，不受 `lensTriggers` 控制，防止审查硬卡死：

- **plan checkpoint** 抑制弱文本 evidence 信号 → 不触发 `evidence-freshness-auditor`（plan 无 apply/evidence 目录）
- **design checkpoint** 抑制 "acceptance criteria" 等弱文本 → 不触发 `acceptance-evidence-auditor`（design 无 apply/evidence）

这两条是已知硬卡死问题的修复，改动需通过 T014-e/T014-f 测试验证。

### 全量回退（FR-LENS-003）

两类情况强制扩大 lens 覆盖：

1. **高风险内容**（`fullFallbackOnHighRisk=true`）：检测到 `scope.riskKeywords`（auth.go、secret、migration 等）时，强制追加 `required-skill-auditor` 等核心 lens，确保全量覆盖。
2. **无匹配内容**（`fullFallbackOnNoMatch=true`）：没有任何内容信号命中时，回退到 `input-contract-auditor`，检查审查包基础合规性。
