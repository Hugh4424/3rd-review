# 执行步骤 0-3.5：前置检查 / 审查包构造 / Host-Verified Facts / 子审查器并行预审

> 本文件由 3rd-review SKILL.md 薄壳引用，主会话不读，审查员/脚本按需读。

## 执行步骤

### 步骤 0：前置检查

#### 0a. Required Skills 可用性预检

**目标**：确保审查员能访问审查需要的所有技能。

按 `checkpoint-id` 确定需要的 skills：

| checkpoint-id 前缀 | required skills |
|---|---|
| `design-review` | plan-ceo-review, review, plan-design-review |
| `plan-review` | speckit-analyze, plan-eng-review, review |
| `test-acceptance-review` | qa-only, verify-change |
| `intake-direction-review` | plan-ceo-review, review |
| `intake-detail-review` | review |

对每个 required skill：adapter 自动完成探测和软链接（FR-PORT-001，follow symlinks）。

- skill 存在 → 继续
- skill 缺失 → `BLOCKED`，停止；用户选择：A) 安装该 skill  B) 跳过（风险：审查可能不完整）  C) 暂停

所有 required skills 可用后，继续下一步。

**注**：CLI 可用性由步骤 A（env_probe）统一探测。缺 reviewer CLI 时不静默继续，按 FR-REVIEW-003 降级走干净子代理审查（见上方"降级形态定义"）。adapter 负责 skills 目录同步（软链接），调用方无需手动执行。

### 步骤 1：提交前自检

仅 `code-review-*` checkpoint 执行。其他 checkpoint 跳过本步。

```bash
bash packages/core/agenthub/harness/gate.sh phase_pre_review <workflow-id> --task-dir=<TASK_DIR> --phase=<N>
```
exit ≠ 0 → 停止，按修复指引修正。

### 步骤 2：checkpoint_request（获取 reviewRequestId）

```bash
bash packages/core/agenthub/harness/gate.sh checkpoint_request <workflow-id> --task-dir=<TASK_DIR> --checkpoint-id=<checkpoint-id> --round=<N>
```
从输出提取 reviewRequestId（`checkpoint_request: <reviewRequestId>`）。Apply phase 的 `<checkpoint-id>` 必须是 `code-review-phase-N`，不要用 `apply` 或 reviewRequestId；gate 在 apply/currentPhase=N 且省略参数时会自动绑定 `code-review-phase-N`。

### 步骤 3：构造审查包

审查包 = Inline Package + Delta Package + Source Manifest + Current Worktree Inventory + Required Read Set + Standards Sources（路径清单） + Verifier Instructions（短入口 + 路径清单）。

#### 3a. Delta Package

按 Delta Package 规则从产物和 git diff 构造。第 2+ 轮从 `reviews.jsonl` 的 `findingsSummary` 快速索引，用 checkpoint + round 从 `reviews/<checkpoint>/round-<round>.json` 回读完整 raw JSON。

#### 3b. Design Sources（phase-scoped inline + full-source manifest，缺 required → escalate_to_human）

| 文件 | design-review | plan-review | code-review | test-acceptance-review |
|------|:--:|:--:|:--:|:--:|
| `specs/<changeId>/spec.md` | required | required | required | required |
| `specs/<changeId>/plan.md` | — | required | required | required |
| `specs/<changeId>/tasks.md` | — | required | required | required |
| `artifacts/decision-log.md` | **required** | **required** | optional | optional |
| tasks.md `design_docs` 声明的额外设计文档 | 若声明→required | 若声明→required | 若声明→required | 若声明→required |

- `—` = 该 stage 此文件尚未生成，不检查
- optional = 存在则附带，不存在→warn

**内联规则**：design/plan 可内联完整被审文档；三份文档合计 >50KB 时改为关键结构内联 + Source Manifest。code-review 必须做 phase 级裁剪：从 checkpoint-id 提取 phase N，内联 `tasks.md` 的 `Phase N` 段；从该 phase tasks 提取 `FR-*` 编号并内联 `spec.md` 对应 FR 段；内联 `plan.md` 的 `Phase N` 段；完整 `spec.md` / `plan.md` / `tasks.md` 路径进入 Source Manifest。无法可靠裁剪 → 回退完整设计源；仍不可读 → `escalate_to_human`。

```text
## Source Manifest
- specs/<changeId>/{spec,plan,tasks}.md — full source, read on demand
- <changed-file> — full source, read on demand; inline package contains diff/hunk context
```

#### 3b-1. Current Worktree Inventory（机器生成，权威）

`Source Manifest` 不能靠手写分组表示当前 worktree。3rd-review 必须从 repo 根执行：

```bash
git status --porcelain=v1
```

并生成 `Current Worktree Inventory`。每个 active changed path 都必须用 exact repo-relative path 列出；包括 modified、added、deleted、renamed、staged、unstaged、untracked。rename 必须同时记录 old path 和 new path。禁止用 `verifiers/...`、`.claude/skills/...` 等简称替代真实路径。

Inventory 每行必须包含：

| 字段 | 说明 |
|---|---|
| status | `git status --porcelain=v1` 的状态 |
| path | exact repo-relative path |
| classification | `design artifact` / `Story 1B scope` / `review-dispatch precondition-fix` / `source-derived-layout precondition-fix` / `setup` / `cleanup` / `unrelated / exclude before review` |
| reason | 为什么该文件属于此分类 |

Inventory 还必须提供统计口径：`statusLineCount`、`uniquePathCount`、`renameOldNewCount`、`untrackedCount`、`deletedCount`。这样 reviewer 可以区分 status 行数、唯一路径数、rename old/new 展开数和未跟踪文件数。

人工 Source Manifest 只能补充说明，不能覆盖机器 inventory。若某个 changed path 没有分类，必须在启动最终 reviewer 前暴露为 high-risk；正式提审时应先修正分类再重试。

#### 3c. Standards Sources（传**路径清单**，不全文注入）

审查方运行在审查员运行时里、能自己读文件。规范文件普遍很长（root CLAUDE.md + 包级 CLAUDE.md + workflow 文档动辄上万字符），**全文注入会让 prompt 臃肿且稀释审查重点**。改为在 prompt 里给出路径清单，让审查方按需自读：

| 文件 | 级别 |
|------|------|
| 根目录 `CLAUDE.md` | required（列路径） |
| 变更文件最近的包级 `CLAUDE.md`（含 `packages/core/agenthub/CLAUDE.md`） | required（列路径） |
| `packages/core/agenthub/workflows/vibecoding/contract.md` | required（列路径） |
| 根目录 `AGENTS.md` | optional（存在则列路径） |

- prompt 里以「Standards Sources — 按需自读以下文件」段给出绝对路径清单 + 一句话说明各文件作用
- 缺 core 文件（路径不存在）→ escalate_to_human
- forbidden files 规则由 root CLAUDE.md 的 "Forbidden core files" 段覆盖，审查方读 CLAUDE.md 时自然获得

#### 3d. Verifier Instructions（短入口 + 路径清单）

从 `--checkpoint-id`（exact，如 `code-review-phase-5`）提取 review kind 前缀，选择对应 verifier。所有 gate、journal、raw JSON 路径统一使用同一 exact `<checkpoint-id>`，不缩写为 review kind：

| checkpoint-id 前缀 | verifier prompt | verifier contract |
|---|---|---|
| `code-review` | `skills/3rd-review/verifiers/vibecoding/code-reviewer.md` | `skills/3rd-review/verifiers/vibecoding/code-reviewer-contract.md` |
| `design` | `skills/3rd-review/verifiers/vibecoding/design-reviewer.md` | `skills/3rd-review/verifiers/vibecoding/design-reviewer-contract.md` |
| `plan` | `skills/3rd-review/verifiers/vibecoding/plan-reviewer.md` | `skills/3rd-review/verifiers/vibecoding/plan-reviewer-contract.md` |
| `test-acceptance` | `skills/3rd-review/verifiers/vibecoding/test-acceptance-reviewer.md` | `skills/3rd-review/verifiers/vibecoding/test-acceptance-reviewer-contract.md` |
| `intake-direction-review` | `skills/3rd-review/verifiers/vibecoding/intake-direction-reviewer.md` | `skills/3rd-review/verifiers/vibecoding/intake-reviewer-contract.md` |
| `intake-detail-review` | `skills/3rd-review/verifiers/vibecoding/intake-detail-reviewer.md` | `skills/3rd-review/verifiers/vibecoding/intake-reviewer-contract.md` |

prompt 只内联短入口，三份完整 verifier 文件列入 Verifier Instruction Manifest：`packages/core/agenthub/skills/3rd-review/verifiers/base-verifier.md`、`packages/core/agenthub/skills/3rd-review/verifiers/vibecoding/<verifier-contract>`、`packages/core/agenthub/skills/3rd-review/verifiers/vibecoding/<verifier-prompt>`。短入口必须包含 review kind、reviewRequestId、verdict schema 输出要求、required skills、blocking 只可来自合同内规则、必须读取 Required Read Set。缺任一 verifier 文件 → `escalate_to_human`；审查员运行时无法读 repo 文件时才回退内联三份原文，并记录 `fallbackCostNote`。

#### 3e. Required Read Set（Final Verifier 必读集合）

Required Read Set 来自 code-review changed hunks、边界/forbidden/core 文件、确定性 preflight signals、reviewer-side delegated bundle 的 `recommendedFinalReadSet`，以及大文件（>80KB）的 changed function/hunk/symbol 区域。prompt 必须列出每项 `path`、`lines/range`、`reason`；无法读取任一 required item → `escalate_to_human`。

### 步骤 3.1：Host-Verified Facts（环境敏感硬事实，precheck 前执行）

**目的**：把审查员运行环境里不可靠的操作（跑 tsx、验证 evidence provenance）前移到 host 执行，reviewer 只读结果不做重跑。

**只放硬事实，不放判断**：

| 事实 | 来源 | 注入位置 |
|------|------|---------|
| repoRoot | `state.json` 或 `git rev-parse --show-toplevel` | `run-delegated-precheck.mjs` `precomputedEvidence()` |
| git HEAD | `git rev-parse HEAD` | 同上 |
| reviewRequestId | prompt 中提取 | 同上 |
| evidence 文件元数据 | 每个 `apply/evidence/*.json` 的 path/hash/cwd/git_sha/exit_code/timestamp | 同上 |
| 四元组 (repoRoot, taskDir, git HEAD, reviewRequestId) | 以上合成 | 同上，打入 bundle.topRisks 如有 mismatch |
| phase 验证命令 + exit code | tasks.md Verify 段 | host 手动构造，注入 prompt Delta Package 段 |

每条事实带 `source`（从哪个命令/文件获取）和 `collectedAt`（ISO 时间戳）。

**审查员合同**：verifier contract 规定有 Host-Verified Facts 时不重跑 evidence command，读取合理性即可（**此豁免仅针对 host 已验证的 evidence 命令重跑，不豁免 ≥80% 改动行读码要求**）。矛盾 → `escalate_to_human`（fail-closed）。详见 `packages/core/agenthub/workflows/vibecoding/code-reviewer-contract.md` 和 `test-acceptance-reviewer-contract.md`。

### 步骤 3.5：子审查器并行预审 + Bundle 生成（强制）

delegated precheck 默认必跑，唯一例外是路由驱动的 R2 降级（`cross_source_no_subagent`）：该档由 route 层判定后，最终审查员独自对全量 diff 全力审查、跳过子审查器 lens 预算（持久化为 `reviewMode=lightweight-review`，受 hash 绑定的 `precheckDecisionSource=route` 约束）。**手动 `--delegated-precheck=off` 仍然禁止**——它是 Phase 6c 封掉的绕过路径，只允许在 adapter 单元测试或人工诊断里用，正式 3rd-review 不得手动关闭。除路由驱动 R2 外没有“直接审查模式”。`review-dispatch-adapter.sh exec --role=reviewer` 会在启动最终审查员前自动规划 lens，并行启动 `--role=subreviewer` 执行子审查器，把合并后的 `Delegated Review Bundle` 注入最终 reviewer prompt。

内置 lens 池（由 `run-delegated-precheck.mjs` 根据当轮信号自动选择）：

`source-manifest-auditor` / `required-skill-auditor` / `scope-boundary-auditor` / `evidence-freshness-auditor` / `mechanical-grep-auditor` / `acceptance-evidence-auditor` / `verifier-closure-auditor` / `browser-qa-auditor` / `plan-traceability-auditor` / `design-intent-auditor`

触发判断逻辑见 `run-delegated-precheck.mjs`（checkpoint-id / review kind / package 信号为强信号；普通文件名、FR 编号等只作弱信号）。不适用的 lens 必须返回 `skipped/not_applicable`；低信息输出 fail-closed。

执行入口：

**后台执行硬规则（主动后台 + 自动唤起 + 三条件校验）**：
- 调用下面的 `review-dispatch-adapter.sh exec`（或 `review` 原子子命令）时，用 Bash 工具的 `run_in_background: true` 主动后台发起。命令 detached 跑、跨 turn 继续，exit 时 harness 自动重新唤起主 agent——不靠用户介入、不靠主 agent 前台轮询盯。
- **后台 Bash 调用必须只含审查命令这一条**：不得拼接任何尾随命令（`; rm ...`/`&& ...`/`| ...`/`find ...`/`echo ...` 等），也不得用 `RESULT=$(...)` 命令替换捕获输出。原因——task-notification 报告的进程退出码是该 Bash 调用**最后一条命令**的退出码；若拼了尾随命令，报告的就是尾随命令（如 `rm`/`find` 恒为 0）的码；若用 `$()` 捕获，subshell 退出码被 bash 丢弃、外层赋值恒 0。两种写法都会把审查命令真实的 exit 2（escalate）掩盖成 exit 0。审查结果必须写入 `--result-file`，准备/清理（mktemp、rm prompt 文件）放在唤起后的前台步骤，不与后台审查命令同句。
- 命令 exit 后做三条件硬校验，全满足才继续推进，任一不满足则前台长 timeout（≥1500000ms）重跑：
  1. 后台进程真的 exit（拿到真实退出状态，非“还在跑”、非被 kill）；
  2. RESULT_FILE 完整可 parse（`jq .` 通过，verdict/findings 等关键字段齐全，非空非半截）；
  3. exit code = 0（delegated precheck + 最终 reviewer + retry +（若走 `review`）persist 全链路成功）。
- 校验的依据是落盘产物（RESULT_FILE + exit code），不是后台完成通知本身：通知只决定“何时去看”，校验才决定“是否成功”。**三条件里 verdict 以 RESULT_FILE 内容为准、exit code 仅作辅助信号**（因为 exit code 经上面的复合语句陷阱可能失真，而 RESULT_FILE 是审查员亲自写的）。这保住了“禁止凭通知假装审查跑完”的原意，同时不浪费已完成的工作。
- 若命令是被 harness **被动**踢后台（未主动声明 `run_in_background` 而出现 `Command running in background`），仍按本轮执行方式失败处理，改为主动后台重跑。

```bash
bash packages/core/agenthub/harness/review-dispatch-adapter.sh exec \
  --prompt-file="$PROMPT_FILE" --result-file="$RESULT_FILE" \
  --checkpoint-id="<checkpoint-id>" --round="<round>" \
  --role=reviewer \
  --delegated-precheck=required
```

adapter 内部关键防伪不变量（详见 `run-delegated-precheck.mjs`）：

- **finalVerifierReadSet** 必须由最终审查员自己输出（实际检阅的原文目标），不得由 adapter 用 recommendedFinalReadSet 伪造
- `_delegatedPrecheck.plannerDecisions` 必须记录每个 lens 的来源、触发原因和信号
- `subreviewerRuntimeReports` 必须分开记录 requestedModel/requestedEffort（请求参数）与 sessionModel/sessionEffort（真实 session 记录）；不得混同
- blocking finding 落盘前必须校验 file/line/snippet 存在于原文

review package 可通过 `Delegated Lens Plan` JSON 补充声明 lens；优先让 Source Manifest / Required Read Set / evidence / contract 信号让 planner 自动判断，只有自动不足时才手写 lens。不要在 adapter 或 persist 里硬编码新 stage。

`--delegated-precheck=off` 只允许在 adapter 单元测试或人工诊断中使用；正式 3rd-review 禁止关闭。precheck 失败时必须 fail-closed，不得继续启动最终 reviewer。

