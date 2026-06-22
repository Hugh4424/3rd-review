# 步骤 6：按 verdict 分流 + post-pass 动作 + 轮次升级规则

> 本文件由 3rd-review SKILL.md 薄壳引用，主会话不读，审查员/脚本按需读。

### 步骤 6：按 verdict 分流

> review-persist.sh（步骤 5）已原子执行：review_dispatched journal → reviewer_output gate → index 重建。无需手动重复。

#### 6a. verdict = pass → post-pass 留存动作

主 agent 必须按顺序执行以下步骤（不可跳过）：

> **post-pass 留存已由 host 自动完成（FR-EVID-001/002）**：pass verdict 时 host 在 reviewer_output gate 自动写 `workflow_feedback_captured` + `stage_summary_end` 两类 journal 事件，**agent 不再需要手工跑 `/skill capture-workflow-feedback`、`/skill stage-summary end`，也不要手工 append-journal-once 这两类事件**（手写 host 事件反而冲突）。
> - `workflow-issues.jsonl` ledger 仍按 gate 路径校验：常态无发现合法（`issues_count: 0`），有真发现时正常追加 ledger entry；host 自动 feedback journal 不替代 ledger 内容本身。深度工作流问题分析确需深挖时再派子代理调 `capture-workflow-feedback`。

**Step 6a-2: post_review_pass gate**
```bash
bash packages/core/agenthub/harness/gate.sh post_review_pass <workflow-id> \
  --checkpoint-id="<checkpoint-id>" --round=<N> --task-dir=<TASK_DIR>
```
→ gate 检查 host 自动写的 `workflow_feedback_captured`/`stage_summary_end` 两类 journal 全部就绪。任一失败 → exit 2

**Step 6a-3: stage_advance**
```bash
bash packages/core/agenthub/harness/gate.sh stage_advance <workflow-id> \
  --task-dir=<TASK_DIR> [--last-phase=true]
```
→ 推进到下一 phase/stage。gate 要求 currentStatus=ready_to_advance（post_review_pass 成功后写入）

#### 6b. verdict = revise_required → 修复循环

主 agent 必须按顺序执行：

1. `/superpowers-receiving-code-review` — 先消化审查报告，不允许直接修代码
2. 生成 `apply/phase-N-review-intake.md`，必须包含 Findings、Root Cause、Fix Plan、Scope Check、Evidence Plan、Re-review Plan
3. 追加 `review-fixes.jsonl` 的 `status=planned` 记录，绑定 checkpoint、sourceRequestId、sourceRound、sourceReport
4. `gate.sh review_intake_complete` — 通过后才进入 `revising`
5. 生成 `apply/phase-N-revise-plan.md`
6. `/superpowers-test-driven-development` — RED/GREEN 重采
7. 追加 `<!-- revision-record -->` 段到上轮 reports/*.md 末尾
8. 更新 `review-fixes.jsonl` 为完整修复记录
9. `gate.sh phase_pre_review` — 确认修复质量
10. 回到步骤 2（checkpoint_request 下一轮）

非首轮 checkpoint_request 会检查以上步骤全部完成（skill calls + phase_pre_review + evidence 重采 + revise-plan + revision-record + review-fixes AJV 校验 + hash 验证），共 8 项 gate 检查。

#### 动态升级规则（FR-REVIEW-011）

审查轮次**不设固定上限**。审查器技能层根据以下规则动态决定路径：

1. **每轮先查根因**：不允许在没有明确根因分析的情况下直接修代码。每轮修复前必须生成 `apply/phase-N-review-intake.md` 含 Root Cause 段。

2. **连续 4 轮同一问题 → escalate_to_human**：
   - 判定依据：连续 4 轮审查报告中，同一 finding（相同文件、相同类别、相同核心描述）重复出现且仍为 blocking
   - 输出：`escalate_to_human`，同时说明"连续 N 轮同一 finding 未解决，需人工介入"
   - **此判定在审查器技能层做出**，不依赖 workflow engine 底层计数器，不在 production 代码中加固定 round 计数器

3. **切换审查形态不等于松护栏**：
   - 后续轮次若为流程/证据问题（非代码逻辑问题），可切换到干净子代理降级形态推进
   - 切换方式**仍受硬护栏约束**（FR-REVIEW-004/005 不变）：高风险维度照审、回归覆盖不降
   - 切方式 ≠ 降标准，任何形态下 blocking finding 的定义和门槛保持一致

4. **根因先于修复**：每轮先彻底理解上一轮的 blocking finding，再执行修复。禁止在未搞清根因时用表面补丁掩盖问题。

**交叉引用**：切换到子代理降级形态时，硬护栏层（FR-REVIEW-004）全部保留，护栏约束见上方"硬护栏层"定义。

#### 降级路由规则（FR-DEG-001/002/003）

`applyPostRoundDegradation` 在 CLI `--history` 路径下自动应用。规则如下（阈值与新领域判据均来自 `route-rules.json` `degradation` 节，不写死）：

| 上轮状态 | 本轮 finding 情况 | 结果 |
|---|---|---|
| 任意 | finding 数 ≤ `maxFindingsForDowngrade`（含单条 blocking） | 降级 → R6（同源子代理） |
| 任意 | finding 数 > 阈值 且全为非 blocking | 降级 → R6 |
| 已降级（R6） | 有 blocking 且属于**新领域**（FR-DEG-002） | 升回 R1（cross_source_with_subagent） |
| 已降级（R6） | 有 blocking 但**非新领域**（FR-DEG-001 粘滞） | 留在 R6（不自动升回 R1） |
| 未降级 | finding 数 > 阈值 且含 blocking | 维持 R1 |

**新领域判定（FR-DEG-003）**：finding 满足以下任一条件即认定为新领域：
- `finding.domain` 在 `newDomainRules.domainLabels` 列表中，且上一轮（immediately previous round）未覆盖该 domain
- `finding.lensType` 在 `newDomainRules.lensTypes` 列表中，且上一轮未覆盖该 lensType
- `finding.codePath` 匹配 `newDomainRules.pathPrefixes` 中某个前缀，且上一轮未见该路径

降级后的 R6 决定必须携带 `cleanContextRequired: true`（FR-QUALITY-001）。

#### 6c. verdict = escalate_to_human → 停止

主 agent 输出升级原因，等待人工介入。

