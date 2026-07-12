---
name: 3rd-review
description: 通用异源 CLI 调用器。用户要求“审查、仔细审查、异源审查、找独立 reviewer”时使用；按全局配置调用其他 provider，返回原始意见、session id 和明确失败诊断，不生成业务 verdict、合同或报告。
---

# 3rd-review

调用方负责准备精简 prompt、材料、审查合同和最终报告；本技能只执行异源 CLI。

```bash
node {skill-root}/scripts/3rd-review.mjs run \
  --request=request.json --config=~/.config/3rd-review/config.json \
  --host-provider=codex
```

首次 request：

```json
{"version":4,"host_provider":"codex","prompt":"请独立审查以下变更...","continuation":null}
```

后续轮次只续跑已有 provider 的原生 session：

```json
{"version":4,"host_provider":"codex","prompt":"根据反馈再检查这两个问题...","continuation":{"runtime_id":"上一轮 runtime_id"}}
```

- `tiers` 内并发；只有该层没有一个真实执行成功才进入下一层。
- 自动排除 `host_provider`；成功和失败都返回，调用方自行合并成功意见。
- 不自动重试、不 fresh fallback、不伪造成功。每个 provider 独立续跑自己的 session。
- 临时状态在 `/tmp/3rd-review`，每次命令自动清理超过 24 小时且没有活跃进程的状态。
- `status` 查看活跃进程；只有 `cancel` 会终止进程。没有默认 120/180 秒限制。

查看完整异常语义与维护约束：[`docs/exceptions.md`](docs/exceptions.md)。
