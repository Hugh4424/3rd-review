# ADR 0001 — V4 CLI 审查执行合同

**状态**：已采纳（2026-07-13）

## 决策

`3rd-review` 是通用、同步、CLI-first 的跨 provider broker。它不包含 workflow stage
合同、业务技能、finding 合并、业务 verdict、报告或自动修复。V4 固定唯一的审查执行
入口：

```text
3rd-review run --config=<config.json> --request=<request.json>
```

唯一的首轮附件扩展是下列完整三元组：

```text
--attachments=<manifest.json>
--attachments-root=<absolute-root>
--attachment-delivery=<file_only|always_embed>
```

三项必须一起出现。首轮可携带初始三元组；附件 runtime 的 continuation 按下文携带
独立 delta 三元组，或显式复用已冻结材料。
`--attachments-root` 必须是 config `attachment_roots` allowlist 中的真实目录，manifest
的 source 必须是该 root 下的安全相对路径和允许 prefix。broker 校验 regular file、size
和 SHA-256 后复制到 provider 私有 workspace；provider 不接触调用方真实仓库。

附件使用 `material protocol v5`。producer 密封后的 packet、diff、manifest 是唯一 authority；
broker 只允许校验、逐字节复制、复验，禁止脱敏、重写或重算 provider-visible 材料。
delivery receipt 记录相等的 `sealed_manifest_hash`、`provider_visible_manifest_hash` 和
`byte_identity: "verified"`。旧附件 runtime 只读，协议不匹配在 provider 启动前返回
`MATERIAL_PROTOCOL_MISMATCH`。

`doctor` 在顶层声明当前材料协议：

```json
{
  "material_protocol": {
    "version": 5,
    "delivery_attestation": "sealed-exact-copy.v1"
  }
}
```

调用方必须在启动 provider 前核对该声明。字段缺失、版本不同或 attestation 不同都属于
`MATERIAL_PROTOCOL_MISMATCH`，不能从 delivery 字段推测兼容。

`file_only` 使用该 provider 私有 workspace 交付冻结文件，不要求 `/etc` policy 或
`/usr/local` wrapper。broker 会拒绝 symlink、hard link、路径穿越、size/hash 不符，并在
运行与续跑前复验冻结副本。这个边界保证材料完整性和稳定路径，不声称替代操作系统 sandbox；
adapter 可继续使用宿主 CLI 原生的只读模式。

## request 与续跑

request 是 JSON，至少包含以下 V4 字段：

```json
{
  "version": 4,
  "host_provider": "codex",
  "prompt": "frozen review packet prompt",
  "continuation": null
}
```

`host_provider` 是受支持的宿主 provider，broker 不让同源 provider 审查。调用方可选
`provider_allowlist`，但其中只能包含不重复、受支持且异源的 provider id。首轮的
`continuation` 为 `null` 或省略；续跑唯一使用：

默认不传 `provider_allowlist`，broker 每个首轮只启动一个异源 provider。显式
`provider_allowlist` 可以列出多个唯一 provider，代表调用方明确请求并行多审；默认路径不得
把 capability discovery 的全部候选自动转换为多 provider allowlist。fallback 只响应稳定的
transport unavailable code；配置、材料、取消、语义结果和无效输出均不得 fallback。

```json
{
  "version": 4,
  "host_provider": "codex",
  "prompt": "delta-only continuation prompt",
  "continuation": { "runtime_id": "<initial-runtime-uuid>" }
}
```

续跑不接收 provider session id。broker 从 runtime 私有状态取得原生 session，只允许两种附件行为：

- delta：request 携带完整、独立密封的 delta 三元组；其 continuation manifest 绑定首轮
  `initial_material_manifest_hash`、递增 `sequence` 和前一轮 `previous_delivery_manifest_hash`。
- reuse：request 不携带附件，并显式设置 `reuse_frozen_material: true`；只复用该 provider/session
  最近一次已验证的冻结材料，不发布新 delta。

普通 continuation 既不携带 delta、也未请求 reuse 时 fail-closed。runtime 过期、找不到、锁争用、
附件变化或没有可续跑 session 都是显式错误/诊断，不能隐式创建新 runtime 或 fresh session。
continuation 只保存 `manifest_hash` / `delivery_manifest_hash` 单链；不存在 raw/derived 双材料、
provider-material 派生 hash，也不迁移旧 timeout/redaction schema。

## stdout、exit code 与错误码

成功执行时，`run` 向 stdout 输出一个 JSON 对象并以 exit code `0` 结束。输出包含
`version`、`runtime_id`、`round`、`host_provider`、`selected_tier` 和每个 provider 的
执行结果。provider 的 transport 失败、跳过、认证失败、超时、取消或输出解析失败仍属于
该 JSON 的 provider result；它们不自动成为 broker 进程错误，也不表示业务 verdict。

请求、配置、附件或 runtime 无法由 broker 接受时，CLI 向 stderr 输出：

```json
{ "error": { "code": "ERROR_CODE", "message": "details" } }
```

并以 exit code `2` 结束。error code 是稳定机器可读的失败分类，例如
`REQUEST_INVALID`、`CONFIG_INVALID`、`ATTACHMENT_ROOT_FORBIDDEN`、
`ATTACHMENT_HASH_MISMATCH`、`ATTACHMENT_IMMUTABLE`、`RUNTIME_EXPIRED`、
`RUNTIME_BUSY`、`NO_CONTINUABLE_SESSION`、`PROVIDER_BUSY`、`PROMPT_TOO_LARGE` 和
`ATTACHMENT_DELIVERY_UNSUPPORTED`。调用方必须保留 code 和诊断，不得把它们映射为 pass。

收到 `SIGINT` 或 `SIGTERM` 时 broker 终止其 provider process tree 并写入
`workflow_shutdown` 取消来源；CLI 分别以 signal exit code `130` 或 `143` 结束。

## runtime、session 与私有原始输出

`runtime_id` 是 broker 生成的 UUID，也是后续 request 允许携带的唯一续跑身份。每个
provider 的 native `session_id`、原始 stdout/stderr、其私有文件引用和绝对路径由 runtime
私有状态保存，不能从 `status` 获得。`run` 的 provider result 可以返回已解析输出、
session id 和原始流 hash；调用方负责把这些视为私有证据并在公开投影中脱敏。

取消只通过以下控制命令进行：

```text
3rd-review cancel --config=<config.json> --runtime-id=<uuid> \
  --provider=<provider> --source=<source>
```

source 只能是 `user`、`workflow_shutdown`、`broker_idle_timeout` 或
`broker_max_duration`。`status` 和 `doctor` 分别只读取脱敏 runtime 状态和执行环境
能力；`doctor` 不做真实模型调用。

## 兼容性边界

`run-heterologous-review.mjs` 不是 V4 接口。任何旧 runner、旧 flag 或未列入
`scripts/3rd-review.mjs` command allowlist 的参数都会被拒绝为 `REQUEST_INVALID`；调用方
只能用本文固定的 `run --request` 合同执行审查。实现依据：

- `scripts/3rd-review.mjs`
- `lib/broker.mjs`
- `lib/attachments.mjs`
- `lib/runtime.mjs`
- `docs/exceptions.md`
