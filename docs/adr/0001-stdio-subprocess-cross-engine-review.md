# ADR-0001：异源审查调用机制从文件复制改为 stdio 子进程调用 omc advisor

日期：2026-07-04
状态：已采纳
任务：zhi66

---

## 背景

3rd-review 原有设计中，异源审查引擎的调用方案是将 omc 的 `run-provider-advisor.js` 文件复制进本仓库，在本地直接 import 执行。

这一方案存在以下问题：
- 文件复制引入 omc 内部实现细节，形成隐式依赖，omc 版本变更时同步成本高；
- 复制文件在本仓库内独立运行，无法复用 omc 的运行时上下文（登录态、模型配置等）；
- 宿主检测能力（detect-agent）未覆盖 Claude/Codex/Cursor/Antigravity 等主流宿主，unknown host 无明确处理语义；
- 首轮真异源约束缺乏机器可执行的强制路径（`--require-heterologous-first-round` 不存在）。

## 决策

**采用 stdio 子进程调用 omc 的 `run-provider-advisor.js` 作为异源审查的主选调用机制。**

具体内容：

1. **调用方式**：通过本地 `run-provider-advisor.js` 以 stdio 子进程启动 omc advisor，走 stdin/stdout JSON 协议交换请求与结果，不复制、不 import omc 内部文件。

2. **宿主检测**：引入 `@vercel/detect-agent`，在 session 启动时一次性检测当前 CLI 宿主，结果写入 report metadata。Kimi/OpenCode 手动兜底。unknown host 触发 fail-fast，拒绝执行，不降级继续跑。

3. **引擎优先级**：Claude > Codex > Kimi > Cursor > Opencode > Antigravity > 其他。

4. **首轮强制异源**：首轮审查必须 true_cross_engine=true；异源全部不可达时触发 escalate_to_human，禁止 same_source pass。

5. **离线兜底**：omc 不可达时自动降级为文件复制离线兜底，并在日志中记录触发条件。

6. **集成契约**：明确 stdio JSON 协议 schema、超时/错误处理规则、不安装 omc 时协议层测试可独立通过。

## 后果

**正面影响：**
- 解耦 omc 实现细节，调用方只依赖 stdio JSON 协议契约，omc 内部升级不影响本仓库；
- 复用 omc 运行时上下文（登录态、模型配置），本地 codex 特殊登录方式兼容；
- unknown host fail-fast 语义明确，防止身份不明的宿主静默通过审查；
- 首轮异源强制可机器执行，满足 stage-gate 硬约束。

**负面影响 / 约束：**
- 依赖 omc 进程可达；不可达时降级为离线兜底文件，降级路径需测试覆盖；
- stdio JSON 协议 schema 需在 build-spec 阶段明确定义（当前为开放问题 OQ-001/OQ-002）；
- 本轮不覆盖同一宿主环境下多 CLI 并发导致宿主身份不稳定的边界场景（D-012）；
- D-013 降级记录字段集（5个字段）需在 S9 用户确认后视为最终锁定。

**可逆性评估：**
低可逆。stdio 子进程协议一旦实现并被上游 workflowhub stage-gate 依赖，切换调用机制需同步修改协议契约和所有调用方。架构级决策，应谨慎变更。
