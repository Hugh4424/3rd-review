# 异常与维护约束

本技能是同步 CLI broker，不是工作流引擎。不要把 prompt 合同、业务 schema、报告、自动修复、自动重派或审查判定加回这里。

| 情况 | 行为 |
| --- | --- |
| 同源 provider | 跳过，`SAME_SOURCE` |
| 未登录、API key 缺失 | 失败，`AUTHENTICATION_FAILED` 或 `AUTH_ENV_MISSING` |
| 网络、TLS、限流 | 保留该 provider 的失败诊断；同层零成功才尝试下一层 |
| CLI 输出格式变化 | `PROVIDER_OUTPUT_INVALID`，不把半截输出当成功 |
| prompt/output 超限 | 明确失败；调用方应缩小材料 |
| 附件不可信 | root/source allowlist、相对路径、regular-file、single-link、size、SHA-256 任一不符都明确失败 |
| 附件投递 | 同一请求按 provider 协商 `file_only`/`always_embed`；无法安全转换时 `ATTACHMENT_DELIVERY_UNSUPPORTED`，不得跳过 |
| 静默但存活 | `process_alive_at_ms` 仅表示 PID 存活；`last_progress_at_ms` 仅由已解析的 provider 流事件更新，二者不能互相替代 |
| 长时间运行 | 生产配置禁止 `idle_timeout_ms=0` 与 `max_duration_ms=0` 同时出现；Kimi 使用 360 秒硬总时限。idle 只看已验证的流进度，分别产生 `IDLE_TIMEOUT`、`PROCESS_TIMEOUT`；同刻触发时后者优先 |
| 用户取消 | `cancel --source` 终止 provider process tree；`status=cancelled`、错误码 `CANCELLED`，来源写入 `error.source`，并保留 `cancellation_source` 兼容字段 |
| broker 退出 | CLI 信号会终止 provider process tree 并记录 `cancellation_source=broker_shutdown`；后续 status/cleanup 发现 owner 丢失或 liveness lease 过期时标记 `ORPHANED_BROKER` 并回收 |
| 并发 provider | 每个 provider 使用私有 workspace；Kimi 的 cwd 可写但 bundle 视图只读，OpenCode 用 Read 分块读取完整 `review-input.md` 到 EOF，不使用会摘要截断的 `--file`；provider 不接触真实 repo |
| 下一轮 | 仅续跑上一轮成功且有 session 的 provider；没有 session 明确失败 |
| 原始输出 | stdout/stderr 分别写入 runtime 私有只读文件；ref、session、output、diagnostic、绝对路径不进入 `status` |
| 临时文件 | 每次 `run`/`doctor`/`status` 清理超过 TTL 且无活跃 pid 的目录 |

配置 JSON 只保存命令、模型、推理强度、认证方式和**环境变量名**。绝不能写入 API key 值。`auth.type=native` 使用 CLI 自己的订阅登录态；`auth.type=env` 只从当前进程环境转发列出的变量。

`host_provider` 来自调用方 request，是受约束的宿主信任边界，broker 不会猜测或认证宿主进程。`run` 的 `providers` 是数组；`status` 返回经过脱敏的 runtime 投影，其中 `providers` 是按 provider id 索引的对象。调用方不得把两者当成同一 JSON schema。

每个 provider adapter 必须只做四件事：构造首轮命令、构造续跑命令、解析最终输出、提供 `--version` doctor 命令。新增 provider 不得改变 broker 的路由或 session 逻辑。

同一 provider 只能出现于一个 tier：把同一 CLI 重复列入后续 tier 会制造新的 fresh 调用，违反“失败不静默重派”。Codex 原生 `exec resume` 不接受 `-C` 或 `-s`；它只续跑首轮创建的同一 session，首轮已固定为 read-only sandbox。
