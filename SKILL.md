---
name: 3rd-review
description: 通用异源 Agent 调用器。用户要求“审查、仔细审查、异源审查、找独立 reviewer”时使用；负责调用其他 provider，不生成业务 verdict 或报告。
triggers:
  - 审查
  - 仔细审查
  - 异源审查
  - review
  - third-party review
mode: lightweight
---

# 3rd-review V3

这是通用的异源 CLI Broker，不是审查规则引擎。

- Broker：全局 provider tier、同源排除、直接 CLI、私有证据、session、状态、取消、有限恢复。
- 调用方：准备有界材料和提示词，解释输出；wh-review 额外负责合同、业务 schema、报告和 stage-result。
- 禁止把 `verdict`、finding、stage、合同语义或报告格式塞回 Broker。

## 调用前

1. 只传给 reviewer 完整但有界的材料 package；不要只给仓库路径让它无限探索。
2. Host wrapper 必须显式填写 `host_hint.provider/backend/wrapper_hash`。同一 provider 会被排除。
3. 配置来自 `~/.config/3rd-review/config.json`（目录 `0700`、文件 `0600`）。JSON 只存 CLI、model、thinking/effort、auth mode 和环境变量名；绝不存 API key 值。
4. 不要设置默认 120/180 秒 deadline。需要硬上限时由调用方显式设置。

## V3 CLI

```bash
node {skill-root}/scripts/3rd-review.mjs run \
  --request=request.json --config=~/.config/3rd-review/config.json \
  --host-provider=<host> --cwd=<bounded-material-cwd>
```

`request.json` 使用 V3 protocol：材料的 UTF-8 bytes/hash 必须一致，首次 `nonce/runtime_id` 为 `null`。CLI 返回 transport result：每个 provider 的 `execution_eligible`、`session_id`、`runtime_id` 和 opaque private refs。

```bash
node {skill-root}/scripts/3rd-review.mjs status --runtime-id=<runtime>
node {skill-root}/scripts/3rd-review.mjs read-private --runtime-id=<runtime> --provider=<id> --nonce=<nonce> --ref=raw|diagnostic|receipt
node {skill-root}/scripts/3rd-review.mjs resume --runtime-id=<runtime> --provider=<id> --session-id=<native> --material-hash=<sha256> --nonce=<nonce> --resume-input=<bounded-delta> --config=<config>
node {skill-root}/scripts/3rd-review.mjs cancel --runtime-id=<runtime> --provider=<id> --attempt-id=<attempt> --nonce=<nonce>
```

## 路由与失败

- 同 tier 并行；只有当前层 **零** 个 `execution_eligible` 才进入下一层。
- 保留成功和失败；调用方合并多个成功输出。
- 每个 provider 只续跑自己的 native session。一次 provider/runtime 最多一次 resume **或** JSON repair；没有 silent fresh。
- 认证、网络、空终态、输出超限、进程死亡和 host block 都只产出诊断，不自动重派。
- 进程活着但沉默时只显示 active/heartbeat；不会隐式 kill。需要停止时显式 `cancel`。
- Codex 的临时认证隔离未通过真实验证时必须返回 `UNSUPPORTED`，不能回退到默认 profile。

完整异常和维护原因见 [`docs/v3-operations.md`](./docs/v3-operations.md)，冻结协议见 [`docs/v3-protocol-freeze.md`](./docs/v3-protocol-freeze.md)。

## V2 兼容面

`standalone.sh` 和 `scripts/run-heterologous-review.mjs` 仅用于旧调用方回归；禁止新增 provider、session、超时或报告逻辑。新的全局 skill 调用必须使用上面的 V3 CLI。
