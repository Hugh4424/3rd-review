# 审查执行证明（tamper-evident，非防伪）

> 本文件由 3rd-review SKILL.md 薄壳引用，主会话不读，审查员/脚本/gate 按需读。

## 审查执行证明（tamper-evident，非防伪）

下面三层是检测执行来源可信度的机制。**单进程共享 shell 架构下无法根除造假**——主 agent 有权写磁盘，就能仿真非ce、挖 hash、写 ledger。所以这是**留证硬化**，不是**防伪**；真的防伪需要进程隔离 / 权限分离（后续 story）。

**绕过事件（2026-06-12）**：orchestrator（主 agent 技能）手写了 review JSON，并用 `--delegated-precheck=off` 跳过了执行层校验。这次绕过在 workflow-issues.jsonl 注入 5 条 `BYPASS`（issue-id: bypass-exec-nonce-phase6c-1~5）。gate+persist 两层均未检出。

**1. `_execNonce` + `reviewRecordHash` 双字段机制（Phase 6c 新增，gate 层机器强制）**

`adapter review exec` 在输出 result-file 时填入 `_execNonce`（随机 16 字节 hex），同时把 nonce + reviewRecordHash（verdict-core-hash.mjs 对核心审查字段的 SHA256）写入 `.machine/source/.exec-nonces.jsonl` 账本。gate 层（`workflow-gate.ts` 的 `validateExecProvenance`）在以下两个点做非门验证：

- **reviewer_output gate**（首次过审，`consumeNonce=false`）：检查 report 有 `_execNonce`、账本可匹配、hash 一致。缺失或不匹配 → `exit 2` BLOCKED。
- **post_review_pass gate**（pass 后前进前，`consumeNonce=true`）：重新加载 round-N.json → 重复上述校验 + 标记 nonce 已消耗（`.exec-nonces-consumed.jsonl`）。nonce 重复消耗 → `exit 2` BLOCKED（replay 检测）。

`intake-text reviewMode` 豁免（无 `_execNonce` 不阻断）。

**2. gate 层唯一合法输入是 `adapter review`（原子 exec+persist 链路）**

绕过本层的唯一方式也得走 adapter exec——唯一从 "nonce 账本" 生成合法条目的入口就是 adapter 的子进程调用。主 agent 手写 report 后直接 `gate.sh reviewer_output --file=...` 会被阶段一（`_execNonce` 缺失）阻断，除非它同时伪造账本（回归"单进程共享 shell"天花板）。

但以下情况**不触发**账本校验：
- **已知架构限制**：上面提到的单进程共享 shell——主 agent 能同时写 gate 的 report 文件和 `.machine/source/.exec-nonces.jsonl` 账本，`_execNonce` 和 hash 都能仿真。本层对诚实 agent 有效，对恶意 agent 无效。
- **绕过事件（2026-06-12）**：orchestrator 跳过了 persist 步骤，直接从 `adapter review exec --delegated-precheck=off` 输出 → `reviewer_output` → `post_review_pass`，不走 atomic persist 链条。此路径已在前 step（`adapter review exec` 加 pnpm filter 后）消除，但留此记录作为设计教训。

**3. AJV / schema 校验 fail-closed，无 retry（保留）**

`review-persist.sh:256`：schema 校验失败 → `process.exit(2)`，立即退出，无自动重试。需修复审查员产出的 JSON 结构后重新以前台 exec 跑完整流程。这是目前唯一的通用机器强制层（因为 schema 不依赖执行链路信息）。

---

