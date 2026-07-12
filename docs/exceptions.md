# 异常与维护约束

本技能是同步 CLI broker，不是工作流引擎。不要把 prompt 合同、业务 schema、报告、自动修复、自动重派或审查判定加回这里。

| 情况 | 行为 |
| --- | --- |
| 同源 provider | 跳过，`SAME_SOURCE` |
| 未登录、API key 缺失 | 失败，`AUTHENTICATION_FAILED` 或 `AUTH_ENV_MISSING` |
| 网络、TLS、限流 | 保留该 provider 的失败诊断；同层零成功才尝试下一层 |
| CLI 输出格式变化 | `PROVIDER_OUTPUT_INVALID`，不把半截输出当成功 |
| prompt/output 超限 | 明确失败；调用方应缩小材料 |
| 静默但存活 | `heartbeat_at_ms` 由独立进程存活观测更新；`last_activity_at_ms` 仅在 stdout/stderr 有新字节时更新 |
| 长时间运行 | 默认 `idle_timeout_ms=0`、`max_duration_ms=0`，不会因固定时限被杀；显式 idle 上限按**输出静默**而非存活判定，显式总时长上限按 wall-clock 判定，分别产生 `IDLE_TIMEOUT`、`PROCESS_TIMEOUT`；同刻触发时后者优先，先发 SIGTERM，5 秒后仍存活才 SIGKILL |
| 用户取消 | `cancel` 终止；先发 SIGTERM，5 秒后仍存活才 SIGKILL，provider `status=cancelled`、错误码为 `CANCELLED`，优先于进程退出错误 |
| broker 崩溃 | 保留 runtime state；后续 `status` 显示失联，不自动重跑原生 session |
| 下一轮 | 仅续跑上一轮成功且有 session 的 provider；没有 session 明确失败 |
| 临时文件 | 每次 `run`/`doctor`/`status` 清理超过 TTL 且无活跃 pid 的目录 |

配置 JSON 只保存命令、模型、推理强度、认证方式和**环境变量名**。绝不能写入 API key 值。`auth.type=native` 使用 CLI 自己的订阅登录态；`auth.type=env` 只从当前进程环境转发列出的变量。

`host_provider` 来自调用方 request，是受约束的宿主信任边界，broker 不会猜测或认证宿主进程。`run` 的 `providers` 是数组；`status` 返回 runtime state，其中 `providers` 是按 provider id 索引的对象。调用方不得把两者当成同一 JSON schema。

每个 provider adapter 必须只做四件事：构造首轮命令、构造续跑命令、解析最终输出、提供 `--version` doctor 命令。新增 provider 不得改变 broker 的路由或 session 逻辑。

同一 provider 只能出现于一个 tier：把同一 CLI 重复列入后续 tier 会制造新的 fresh 调用，违反“失败不静默重派”。Codex 原生 `exec resume` 不接受 `-C` 或 `-s`；它只续跑首轮创建的同一 session，首轮已固定为 read-only sandbox。
