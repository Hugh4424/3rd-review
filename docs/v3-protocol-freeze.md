# 3rd-review V3 Protocol Freeze（Phase 0）

本文是 V3 的维护边界。后续重构不得删除或放宽其中的字段、绑定或失败语义；新增 provider 只能在 adapter 内实现，不得把业务审查规则重新塞回 Broker。

完整的架构、异常矩阵和 R01–R60 覆盖在 workflowhub 的 `docs/3rd-review-redesign-v3.md`。本文件只冻结可机器验证的通用执行协议。

## 责任边界

Broker 接收有界材料、冻结配置、启动异源 provider、保存原始执行证据并返回 transport result。它不解析 `verdict`、`findings`、stage、合同正文或报告格式。

wh-review 负责提示词、合同、业务输出验证、意见合并、报告和 stage-result。任何把这些字段加回 V3 Broker 的改动都属于架构倒退。

## Request

```json
{
  "protocol_version": 3,
  "request_id": "UUIDv4",
  "nonce": "base64url opaque token or null on first call",
  "runtime_id": null,
  "round": 1,
  "host_hint": {"provider": "codex", "backend": "codex-cli", "wrapper_hash": "sha256:..."},
  "material": {"encoding": "text", "text": "bounded input", "input_hash": "sha256:...", "bytes": 123},
  "contract_ref": "opaque://wh-review/contract-hash",
  "previous_receipt_hash": null,
  "force_tier": null,
  "overrides": {}
}
```

- `request_id` 必须是 UUIDv4；`nonce`、`runtime_id`、provider id 只能是 1–128 位 `[A-Za-z0-9_-]`。它们不是路径。
- 首次请求可缺 nonce；Broker 生成后在 result 中返回。已经存在的 `request_id` 缺 nonce 返回 `NONCE_REQUIRED`；不同 nonce 返回 `REPLAY_DETECTED`。
- `material.text` 先拒绝未配对 UTF-16 surrogate，再按严格 UTF-8 重新计算 bytes/hash。声明不一致是 `REQUEST_INVALID`，不能替换成 U+FFFD 后继续执行。
- `round=1` 的 runtime/previous receipt 必须是 `null`。后续轮次必须有同 provider、同 runtime 的上一 receipt hash；不允许跳轮或自动 fresh。
- `contract_ref` 是最长 512 UTF-8 字节的 `opaque://` 绑定值。Broker 不读合同内容。

## Config snapshot

每次新请求将全局 JSON canonicalize 后得到 `config_hash`。canonical JSON 使用 UTF-8、Unicode code-point 键排序、数组原顺序、无空白，拒绝未配对 surrogate、`NaN`、`Infinity`、`-0` 和非 JSON 值。

该 hash、完整 snapshot、provider profile/model/backend/auth mode 进入私有 receipt。resume 的任意一项不同都返回 `CONFIG_SNAPSHOT_CHANGED`，不得悄悄复用旧 session。

全局配置只允许存 provider CLI 的 model/effort/auth mode、环境变量名或 config reference，绝不存 API key 值。默认配置路径最终是 `~/.config/3rd-review/config.json`；Phase 3 才实现 tier 路由和完整配置校验。

## Canonical result

```json
{
  "protocol_version": 3,
  "request_id": "UUIDv4",
  "nonce": "opaque",
  "config_hash": "sha256:...",
  "selected_tier": 0,
  "stop_reason": "execution_eligible|no_eligible|forced_tier|all_failed|runtime_unavailable",
  "providers": [{
    "id": "kimi",
    "status": "completed|failed|cancelled|deadline_exceeded",
    "execution_eligible": true,
    "session_id": "native-id-or-null",
    "runtime_id": "opaque",
    "receipt_ref": "private://...",
    "diagnostic_ref": null,
    "metrics": {"elapsed_ms": 0, "turns": 0, "input_bytes": 0, "output_bytes": 0, "retry_count": 0},
    "error_code": null,
    "persisted": true
  }]
}
```

`execution_eligible` 只表示独立、可解析、已持久化的 transport 成功，不表示合同正确或业务通过。`verdict`、`findings`、`approval_eligible` 禁止出现在 V3 result。raw output 也禁止出现在 result。

若 raw/receipt/diagnostic 不能持久化，provider 必须为 `failed(error_code=RUNTIME_UNAVAILABLE, persisted=false)`；不能用内存数据伪装 `completed`。

## Receipt 与 read-private

私有 receipt 绑定 request/nonce/owner uid/runtime/provider/round/config snapshot/material hash/contract ref/session/profile/expiry。raw 和 diagnostic 只通过下面的固定接口读取：

```text
3rd-review read-private --runtime-id <id> --provider <provider> --nonce <nonce> --ref raw|diagnostic|receipt
```

ref 不是文件名；除 `raw`、`diagnostic`、`receipt` 外一律 `REQUEST_INVALID`。Phase 1 写入 `$TMPDIR/3rd-review/<runtime>/<provider>/` 的 `0700/0600` 私有文件，并用 uid、nonce、lstat/realpath containment 拒绝 `..`、symlink、跨 runtime/provider 读取。

receipt 与 nonce 的终态 TTL 是 24 小时。active lease 不会被 TTL 或默认 wall-clock kill；过期终态返回 `NONCE_EXPIRED`，调用方只能创建新的 request。

## Phase 0 的可运行基线

`scripts/3rd-review.mjs` 是唯一的新 V3 入口：

```bash
node scripts/3rd-review.mjs validate --request=request.json
node scripts/3rd-review.mjs run --request=request.json --output=result.json --adapter=mock
```

`--adapter=mock` 只验证协议、材料完整传递、nonce 幂等和私有读取绑定；它不调用任何模型，不可用于真实审查。真实 direct spawn、private filesystem receipt、provider adapters、tier 路由和 recovery 分别由后续 phase 接入。

### Claude Code 已验证的审查 profile

Claude adapter 必须直接交付 bounded material，禁止只给 repo 路径再让模型进入探索。非交互审查固定使用 `permission-mode=dontAsk`、`--safe-mode`、`--disable-slash-commands`、`--allowedTools Read` 和显式禁用 Agent/Bash/Write/网络等所有 non-Read 工具；**禁止** `permission-mode=plan`。

原因不是偏好：本机真实复现表明 plan mode 会触发 Plan/Agent 多工具链。在 OpenAI-compatible Claude backend 上，这条链可以持续输出 thinking/tool events，却没有 terminal result，表面看起来像“空输出”。同一 CLI 使用有界直传材料与只读 `dontAsk` profile 可正常返回最终 JSON。因此 adapter 必须把“0 exit 但 stdout 为空、或 stream 没有 terminal result”归类为 `PROVIDER_PROTOCOL_INCOMPLETE`，持久化 partial diagnostic、`execution_eligible=false`、进入其他 provider/tier；无 native session 时禁止 automatic fresh。

旧 `standalone.sh` 与 `scripts/run-heterologous-review.mjs` 是 V2 compatibility surface：仅保留现有行为与回归测试，不新增 provider、认证、timeout、session 或报告功能。wh-review 在 V3 完成前仍通过旧兼容接口调用；Phase 6 才切换。

## 失败语义不得删除

- request：`REQUEST_INVALID`、`INPUT_TOO_LARGE`、`NONCE_REQUIRED`、`REPLAY_DETECTED`、`NONCE_EXPIRED`
- config：`CONFIG_INVALID`、`CONFIG_SNAPSHOT_CHANGED`
- private binding：`BINDING_MISMATCH`
- future runtime：`RUNTIME_UNAVAILABLE`、`PROCESS_DIED`、`DEADLINE_EXCEEDED`、`OUTPUT_LIMIT`、`PROVIDER_PROTOCOL_INCOMPLETE`、`CONTINUATION_FAILED`

没有默认 120/180 秒 kill。未来 supervisor 只能在调用方或配置显式 `deadline_seconds` 时结束进程；idle/stall 只更新状态，不自动重派或 fresh。
