# V3 全局配置

复制 `config.example.json` 到 `~/.config/3rd-review/config.json`，设为 `0600`，再把每个 `command` 改为本机绝对路径。V3 只读取这一个 JSON；host、wh-review 和 provider adapter 不各自维护顺序。

- `tiers` 从上到下执行；同 tier 并行；只有本层没有 `execution_eligible` 成功时才进入下一层。
- Broker 自动排除与 `host_hint.provider` 同源的 provider。成功结果都保留；失败只保留 receipt/diagnostic，不会自动 fresh 重派。
- `model`、`effort`、`thinking` 是每 provider 的成本/质量控制。`deadline_seconds: null` 没有默认墙钟杀进程。
- V3 不接受未实现的 token/turn/预算或 idle 配置字段，避免把无效上限伪装成保护。输入/输出字节上限和显式 deadline 是当前唯一 broker 级硬限制。
- `auth_env` 只写环境变量名字，例如 `MOONSHOT_API_KEY`；JSON、receipt、报告和 argv 禁止保存密钥值。订阅 CLI 应使用 `native_login`。
- Kimi/OpenCode 的只读 profile 每次在 runtime 自动生成，配置不再要求 profile 路径或 agent 名。审查材料只放在 runtime 的 `materials/`，而不是项目目录。
- Kimi 的 profile 只允许 `ReadFile`、`Glob`、`Grep`；OpenCode 的 profile 默认拒绝全部权限后只允许 `read/glob/grep/list`，并设置 `--pure`、`OPENCODE_DISABLE_CLAUDE_CODE=1`。
- 为了复用订阅 CLI 的登录态，provider 自己的 session/cache 仍在其原生 home；这不是 OS 级容器隔离。runtime 不复制认证信息，24 小时后由 broker 自动清理。
- Codex 使用其原生订阅 CLI 登录态，不复制 `auth.json`。启动时固定 `--sandbox read-only --ignore-user-config --ignore-rules`，工作目录是 runtime `materials/`；续跑复用该 native session。它不使用 `--ephemeral`，因为那会破坏续跑。

`wh-review` 启用 V3 时设置：

```text
WH_REVIEW_EXECUTOR=v3
THIRD_REVIEW_CONFIG=~/.config/3rd-review/config.json
```

可选 `THIRD_REVIEW_V3_COMMAND` 与 `THIRD_REVIEW_RUNTIME_ROOT` 只用于非标准安装位置和测试。runtime 默认在 `$TMPDIR/3rd-review`，终态数据 24 小时后自动清理。

修改配置后先运行 `node scripts/3rd-review.mjs doctor --config=~/.config/3rd-review/config.json`。doctor 不调用模型；它检查私有配置、CLI 二进制/必要 flags、自动 profile 生成，以及 env/config-ref 认证前置条件。`native_login` 只能标记为“可启动”，最终登录有效性仍由第一次真实 review 的 receipt 证明。
