# 脱平台使用场景（D12）

> 本文件由 3rd-review SKILL.md 薄壳引用，主会话不读，standalone 入口/子代理按需读。

本技能的核心能力是**独立、对抗式的代码/文档审查**，不绑定 agenthub 工作流。两种使用场景共享同一套审查策略（SKILL.md + references/）与判定脚本，只有环境差异收进两个薄适配入口：

- **agenthub 内（gated）**：主 agent 经 `checkpoint_request` 触发，走 `review-dispatch-adapter.sh`，落盘进 task 目录，受 gate 校验。
- **脱平台（standalone）**：像找一位同事在干净环境里审查你的代码或文档——无 gate、无 journal、无 reviewRequestId 绑定。入口是 `skills/3rd-review/standalone.sh`（RD-4），产物落 `<output-root>/tasks/<name>/`，裁决 JSON 标记 `provenance: "single-context"`（standalone 裁决不可拷回 agenthub 充当 gated 裁决——会被 `reviewer_output` 防伪 assert 拒绝）。
