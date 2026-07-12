# V3 运行与异常语义

这份文件是维护约束。不要为了“更快成功”删除下面的失败分支、改成 fresh 重派，或把业务审查规则加回 Broker。

## 谁负责什么

- 3rd-review：直接启动异源 CLI、tier 路由、私有运行目录、session、原始输出、状态、取消和 transport 结果。
- wh-review：审查提示词和合同、材料 package、业务 schema、意见合并、报告和 stage-result。

Broker 的 `execution_eligible` 只表示可持久化的 transport 成功；它绝不表示业务 verdict 通过。

## 正常执行

1. `run` 从 `~/.config/3rd-review/config.json`（或显式路径）读取全局 JSON。
2. 同一 tier 并行；当前层没有一个 `execution_eligible` 才进下一层。
3. 同源 provider 被跳过；host 未验证时结果只能保留为参考，不能停止 fallback。
4. 每个 provider 单独保存 native `session_id`。续跑只能使用自己的 session。
5. `$TMPDIR/3rd-review/<runtime>/` 目录 `0700`、文件 `0600`；结果仅给 opaque `private://` ref。

## 时间与进程

- 默认 `deadline_seconds=null`。没有 120/180 秒隐式 kill。
- stdout/stderr 增长会更新 activity；heartbeat 只说明子进程仍被监控，不假装模型正在产出。
- 无输出但进程活着：保持 running，可用 `status` 观察或 `cancel` 显式终止；不会自动重派。
- `cancel` 使用持久 active record、PID start fingerprint 和独立 process group。它必须带 runtime/provider/attempt/nonce，避免误杀其他任务。
- `OUTPUT_LIMIT`、显式 deadline、取消、非零退出、认证与网络失败都保留诊断，不自动 fresh。

## 恢复与重试

- 一个 runtime/provider 总共最多一次 recovery：同 session `resume` **或** `INVALID_JSON` repair，不能串联。
- 认证、进程死亡、网络、idle、输出截断、无 terminal envelope 都不自动重试。
- 恢复前校验 runtime、provider、native session、config hash、profile hash、初始材料 hash 和 24 小时 TTL；不一致立即失败。
- 新 broker/新 CLI 进程会从私有 recovery state 恢复绑定；不会把 Kimi/Claude/Codex/OpenCode 的 session 互相混用。

## 常见异常

| 现象 | 代码 | 自动行为 |
| --- | --- | --- |
| CLI 不可用/认证失败 | `PROCESS_*` / `AUTH_*` | 记录失败，继续同层其他 provider 或 fallback |
| CLI 退出 0 但无终态 | `PROVIDER_PROTOCOL_INCOMPLETE` | 保存 raw/diagnostic，不算成功 |
| 输入过大 | `INPUT_TOO_LARGE` | spawn 前拒绝 |
| 输出超限 | `OUTPUT_LIMIT` | 停止该进程，不 repair |
| provider 输出完整但 JSON 无效 | `INVALID_JSON` | 有 native session 时最多一次 repair |
| 运行中无输出 | status active/heartbeat | 等待或显式 cancel，不 fresh |
| config/profile 漂移 | `CONFIG_SNAPSHOT_CHANGED` | 拒绝续跑旧 session |
| nonce/runtime/provider 不匹配 | `BINDING_MISMATCH` | 拒绝私有读取、取消或续跑 |
| runtime 过期 | `NONCE_EXPIRED` | 不复用 request id，发起新请求 |

## 凭据与输出

- 全局 JSON 只放 `auth_env` 名称、native login 或 config reference，绝不放 key 值。
- adapter 只继承基础环境和显式声明的认证变量；secret 不进入 argv、receipt、公开结果或报告。
- 已声明 `auth_env` 的值在 raw/stderr 写入完成前脱敏。脱敏失败必须降级为 `RUNTIME_UNAVAILABLE`，不能宣称该结果可安全读取。
- `read-private` 必须带 nonce，并只接受 `raw|diagnostic|receipt`；不能传任意文件路径。

## 扩展 provider

新增 provider 只新增一个薄 adapter：`probe`、`buildStart`、`buildResume`、`parse`。不要改 router、supervisor、job store 或 wh-review 的业务规则。

先做短真实 smoke，再把它列为 supported。未验证认证隔离或 native continuation 时返回 `UNSUPPORTED`，不要伪造成功。
