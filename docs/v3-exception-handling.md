# V3 异常与恢复边界

V3 只负责调用异源 CLI、持久化 transport receipt 和私有诊断；不会把失败伪装成审查结论，也不会自动 fresh 重派。

| 情况 | 结果 | 自动行为 |
| --- | --- | --- |
| CLI 未安装或 profile 不可建 | `CONFIG_INVALID` / `RUNTIME_UNAVAILABLE` | 保留失败，尝试下一层 |
| 登录、订阅或 API key 无效 | `AUTHENTICATION_FAILED` | 不重试；修认证后新 request |
| 网络、DNS、TLS 证书 | `NETWORK_UNAVAILABLE` / `NETWORK_TLS_CERTIFICATE` | 不重试；保留诊断，下一层可继续 |
| 供应商限流 | `RATE_LIMITED` | 不 fresh 重派；由下一层提供意见 |
| CLI 被 provider 拒绝文件访问 | `PROVIDER_PERMISSION_DENIED` | 不扩大 profile 权限；保留诊断 |
| CLI 非零退出 | `PROCESS_EXIT_NONZERO` | 保存 raw/diagnostic，下一层可继续 |
| 输出不是完整机器格式 | `PROVIDER_PROTOCOL_INCOMPLETE` | 不把文本当成功；不重派 |
| 输出超过上限 | `OUTPUT_LIMIT_EXCEEDED` | 明确失败，不截断成成功 |
| 用户取消 | `CANCELLED` | 结束该 attempt，不自动恢复 |
| 续跑锁持有者崩溃 | `CONTINUATION_INTERRUPTED` | 不重跑同一 native session；保留已有 receipt |
| 显式 deadline | `DEADLINE_EXCEEDED` | 仅用户配置 deadline 才终止 |
| CLI 仍有 activity | 无超时 | 默认持续监控，不采用 120/180 秒杀进程 |

首轮成功后，后续业务轮次只续跑该 provider 自己 receipt 中的 native session。无法续跑时记录失败，不得换成 fresh session。V3 的 transport 修复预算仅允许一次同 session 的 JSON 修复；它不等同于业务重新审查。

Kimi/OpenCode 的 broker profile 只允许读取 runtime `materials/`；不会复制 API key 或 OAuth 数据。为保留订阅 CLI 登录态，provider 仍可能在自身 home 写 session/cache；需要 OS 级隔离时应使用独立账户或容器，而不是误以为 profile 已提供容器隔离。

`provider_profile_hash` 绑定生成 profile 的版本。runtime 只保留 24 小时；部署 profile 语义变更后，24 小时内残留的旧 runtime 不保证可继续恢复，必须由调用方新建首轮 request，不能用兼容映射绕过 profile 绑定。
