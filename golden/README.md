# 3rd-review Golden Fixture Set

## 核心声明

**Fixture 测什么 = 裁决结论一致。不测执行步骤。**

具体来说：测 verdict 三值、blocking 数量与标题集、报告必备章节是否齐全、审查维度是否覆盖、verdict 降级时是否带理由。

**不测的内容**：gate 推进流程、journal 事件、reviewRequestId、checkpoint 状态机。这些是 agenthub-only 后处理，standalone 环境没有；如果测执行步骤，两环境就无法共享同一套用例。

权威依据：RD-1（plan.md）+ D4-design 任务（decision-log.md）。

---

## 五元组 Schema 说明

每个情形目录下有两个文件：
- `input.md`：审查输入包（被审查的代码 diff 或文档片段 + 必要上下文）
- `expected.json`：质量基线五元组期望

`expected.json` 结构：

```json
{
  "case": "<case-slug>",
  "scenario": "<情形中文名>",
  "expected": {
    "verdict": "pass | revise_required | escalate_to_human",
    "blockingCount": <number>,
    "blockingTitles": ["<标题>", ...],
    "requiredSections": ["Summary", "Findings", "Checks", "Required Revisions"],
    "reviewDimensions": ["方向", "盲点", "细节"],
    "downgradeReasonRequired": true | false
  },
  "rationale": "<为什么期望这个裁决>"
}
```

五元组来源：
- ① verdict 三值：base-verifier.md Verdict Rules
- ② blockingCount + blockingTitles：审查报告 blocking findings
- ③ requiredSections：base-verifier.md 报告格式段 `Summary / Findings / Checks / Required Revisions`
- ④ reviewDimensions：O12 定义的 3rd-review "方向/盲点/细节"（高风险情形可加"架构边界"）
- ⑤ downgradeReasonRequired：verdict != pass 时为 true（降级必须带理由），pass 时为 false

---

## 八情形索引表

| case-slug | 情形 | 期望 verdict | blocking 数 |
|---|---|---|---|
| simple-text | 简单文本（干净小改/文档） | pass | 0 |
| missing-context | 缺上下文（审查输入信息不足） | revise_required | ≥1 |
| high-risk | 高风险（触碰安全/forbidden/破坏性） | revise_required | ≥1 |
| wrong-request-id | 错请求标识（reviewRequestId 不匹配） | revise_required | ≥1 |
| missing-gate | 缺门禁（缺 RED/GREEN 证据或 gate 证明） | revise_required | ≥1 |
| rename-compat | 改名目录兼容（软链/改名后仍可识别） | pass | 0 |
| capability-missing | 能力缺失（provider 缺所需能力） | escalate_to_human | — |
| path-conflict | 路径冲突（worktree/路径冲突） | revise_required | ≥1 |
