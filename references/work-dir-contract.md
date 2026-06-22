# 通用契约：work-dir 抽象

> 本文件由 3rd-review SKILL.md 薄壳引用，主会话不读，适配入口/子代理按需读。

审查策略层（SKILL.md + references/ + 判定脚本）只认抽象的 **work-dir**（审查产物的落盘根），不写死平台细节：

- **agenthub 适配**：work-dir = task 目录（`--task-dir`，缺失时 adapter fail-fast 并提示需要 `task-dir`）。审查身份来自 `checkpoint_request` 生成的 `reviewRequestId`。
- **standalone 适配**：work-dir = `<output-root>/tasks/<name>/`（O9 生成的任务名）。审查身份来自 standalone 自生成的 request id。

适配差异只活在 `review-dispatch-adapter.sh`（agenthub）与 `standalone.sh`（脱平台）两个入口；本技能其余部分对两者一视同仁。
