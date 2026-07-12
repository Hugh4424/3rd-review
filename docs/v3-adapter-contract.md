# V3 provider adapter contract

每个 provider 只实现 `probe`、`buildStart`、`buildResume`、`parse` 四个函数。它构造 argv、受限环境、输入传递和 native output parsing；它不解释 review verdict、合同或 stage。

## 不可删除约束

- command 永远由 supervisor 以 `shell:false` 启动；prompt 不拼 shell 字符串。
- 环境从 `PATH`、`HOME`、locale、`NO_COLOR`、配置声明的 auth 变量名中取值，并强制 `THIRD_REVIEW_ACTIVE=1`；secret 值不进 receipt、argv、报告或全局 JSON。
- 空 stdout、没有 final text、或机器流没有可解析终态，统一返回 `PROVIDER_PROTOCOL_INCOMPLETE`；不能把 exit 0 当成功，更不能 silent fresh。
- `buildResume` 只接受自己的 native session id。它不接受其他 provider 的 session，也不重新投喂首轮材料；如需 repair，只能使用独立的 bounded `resume_input`。
- Kimi 与 OpenCode 没有受约束 profile 时拒绝启动；不能以 `--plan`、`--pure` 或默认 agent 假装只读。
- Claude 的主安全边界是 `--safe-mode --allowedTools Read`；显式 non-Read deny-list 是版本兼容的第二道防线。probe/smoke 必须验证 allowlist 被当前 CLI 接受；未知或不支持时拒绝，不退回普通 profile。

## 本机真实 smoke（2026-07-12）

| Provider | 已验证调用 | 实际 terminal envelope | 当前限制 |
| --- | --- | --- | --- |
| Claude Code | stdin + `-p`, `dontAsk`, safe mode, Read allow/deny | JSON `result`、`session_id`、`usage` | 禁止 plan、bare |
| Kimi 1.48.0 | stdin + print/stream-json + readonly agent file | JSON `{role,content}`；resume 提示含 `kimi -r <id>` | profile 由 runtime 提供 |
| Codex 0.144.1 | `exec -s read-only --json -` | JSONL `thread.started`、agent message、turn usage | 临时 auth staging 未验收，当前拒绝启动 |
| OpenCode 1.17.18 | `run --pure --format json --agent <readonly>`；同 session `--session <id>` | JSONL `sessionID`、`part.text`、`part.tokens`、`step_finish` | 只读 agent 必须由 runtime project config 创建 |

Codex 的 `exec` 子命令不接受 `-a never`；不得从旧版本示例复制该 flag。`--ignore-user-config` 在本机仍加载全局 skills，不能当隔离措施。后续 runtime profile 必须实测“临时 `CODEX_HOME` + 仅认证状态”后才可以标记为 supported；未通过时返回 `UNSUPPORTED`，而不是回退到有副作用的默认 profile。adapter 同时要求已验证标记和非空 `CODEX_HOME`，避免调用方误把默认 HOME 当隔离 runtime。当前 `exec resume` 也没有 `cwd` 或 sandbox 参数，不能推测它仍是 read-only，因此同样返回 `UNSUPPORTED`。

Claude 的 deny-list 不承担枚举未来工具的安全职责：`--allowedTools Read` 是主 allowlist，未知工具不在 allowlist 内就不能调用；safe mode 还关闭自定义 skills、plugins、hooks、MCP 和 agents。每次真实 Claude smoke 都必须带这两个 flags；CLI 不接受或 smoke 显示非 Read 工具被调用时，adapter 直接降为 `UNSUPPORTED`。
