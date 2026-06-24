<div align="center">

# 🔍 3rd-review

### 一份你的 AI 没法自己盖章放行的代码审查。

**让另一个 AI 来查你的 AI 写的活——这样「没问题 ✅」才真的算数。**

[![test](https://github.com/Hugh4424/3rd-review/actions/workflows/test.yml/badge.svg)](https://github.com/Hugh4424/3rd-review/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md)

<br>

<img src="./assets/showcase-review.png" alt="3rd-review 抓出 AI 作者觉得「没问题」的命令注入" width="680">

<sub>对 [`examples/sample.diff`](./examples/sample.diff) 的真实一次运行：一段 AI 作者会当成「不就是打个 tar 包」放过的代码——独立审查员一轮就抓出了命令注入和路径穿越。</sub>

</div>

---

## ✨ 一句话讲清痛点

你让 AI 写一段代码。然后你让*同一个* AI 审查它。

> **你：** 审查一下你刚写的代码。
> **AI：** ✅ 没问题，挺好的！

它当然说没问题。它在给自己的作业打分——而且写的时候有啥盲区，审的时候还是那些盲区。那个绿色的勾，是**演戏。**

`3rd-review` 用一条简单规则解决它：

> **写代码的，永远不许给自己放行。**

换*另一个*引擎来审——OpenAI 的 `codex`、Google 的 `gemini`，再不济也是一个看不到原始对话的全新 AI 会话。每一次，都自动给你一个独立的第二意见。

**我们自己跑这套流水线时的真事：** 一个 AI 把自己的改动标成了 `pass`。我们改用一个*独立*审查员重审，结果它**审了 6 轮**才真过——一路上揪出了一个偷偷放行失败的 CI、一条绕过安全门的捷径、还有一个根本对不上的数据格式。最初那个「pass」一文不值。

---

## 🎯 你能得到什么

| 你的情况 | 平时会发生啥 | 用了 3rd-review |
|---|---|---|
| AI 自己写、自己审 | 它给自己放行，盲区照旧 | 换**另一个** AI 出裁决 |
| 一个又大又枯燥的 diff | 一个审查员从头啃到尾 | 苦力活**拆给多个帮手 AI**分担 |
| 改个文档小错别字 | 还跑全套重型审查，纯属浪费 | 自动切成又快又省的轻检查 |
| 审查员没完没了地挑刺 | 你被困在死循环里 | 它能察觉卡壳，**直接叫人来** |
| AI 装个「pass」假装干完了 | 没人发现 | 内置机制**抓得到这种假货** |

---

## 🚀 快速上手

`3rd-review` 把你的代码/diff 交给一个独立审查员，给你一个简单的裁决：**通过**、**要返修**、还是**得叫人**。

**1. 你需要一个「审查员」——真正干审查活的那个 AI。** 我们自带了一个现成的，用 OpenAI 的 `codex`。（只要装了 `codex` 和 `python3` 就行。）

**2. 把要审的东西指给它。** `--input` 是要审的文件或 diff，`--output-root` 是报告放哪，`--review-runner` 是谁来审：

```bash
# 先拿仓库自带的示例冒个烟（就是截图里那个命令注入 diff）：
./standalone.sh \
  --input=examples/sample.diff \
  --output-root=./reviews \
  --review-runner="$PWD/examples/codex-runner.sh" \
  --max-revise-rounds=1

# …然后把 --input 换成你自己的文件或 diff。
```

**3. 看结果——就看退出码：**

| 退出码 | 意思 |
|---|---|
| `0` | ✅ **通过**——独立审查员认可了 |
| `2` | 🙋 **得叫人**——摆不平（返修来回好几轮、轮次用完了，也是这个码） |
| 其它 | ⚠️ 出错了 |

完整报告（审了啥、发现了啥）会落在 `./reviews/tasks/{id}/reviews/report.md`。

> 其实底下还有个 `1`（「要返修」）裁决，但 `standalone.sh` 不会停在这——审查员要求返修时，它会循环重审，只有真的需要人来定夺时才停下、返回 `2`（默认来回 3 轮还没解决就升级人工）。

> **想换个审查员**（Gemini、本地模型、你自己那套）？复制 [`examples/codex-runner.sh`](./examples/codex-runner.sh)，把里面调 `codex` 的那一行换掉就行。任何「读 prompt、返回裁决」的命令都能接。

---

## 🛡️ 凭什么相信这个「pass」

绿灯太好造假了。三道护栏让这一个真的算数：

- **审查员永远不是作者。** 最终裁决永远来自一个独立的、另外的 AI。整件事的核心就是：谁都不许给自己放行。

- **「pass」必须拿出证据。** 审查员不能光说「挺好的」——它得附上*审了啥*的凭证：审了哪些文件、哪些有风险的地方它看过、为啥判定它们没事。**没凭证 → 不给过。**（而且证据里的判断部分它没法伪造——敢留空，这个 pass 就直接被打回。）

- **假货蒙混不过去。** 一份没有凭证的手写「pass」会被当场拒掉。而在完整的平台模式下，每次真审查还会留下一个防篡改的指纹，假的没有。*（对边界很诚实：standalone 版主要靠独立审查员 + 上面那条「pass 必带证据」的规则；密码学指纹在平台的 gated 路径里。而且就算是它，对一个有完整磁盘权限的恶意程序也不是铁板一块——那得靠更强的进程隔离。这道护栏挡的是手滑和偷懒造假，不是铁了心的攻击者。）*

---

## 🧠 最妙的地方：审查是个旋钮，不是一把锤子

不是每个改动都该受一样的盘查。改一个错别字和动一次数据库迁移，不该用同一种审查——那要么是浪费、要么是危险。

所以 3rd-review **会自动决定审得多狠**，看你改了啥：

```
   越狠 / 越彻底 / 越贵
        ▲
        │   大段代码改动  →  独立 AI + 多个帮手分工审
        │   中等改动      →  一个独立 AI 来审
        │   极小 / 纯文档  →  快速、便宜的隔离检查
        ▼
   越轻 / 越快 / 越省
```

**唯一不让步的规则：** 凡是碰到登录、数据迁移、删除的，一律走**最重**的审查，不管看起来多小。风险只会让审查*更强*，绝不会更弱。

> 💡 我们最久才悟到的一点：把活拆给帮手 AI，不是为了让审查*更强*——是为了在大活上*更省*。独立性是你绝不放弃的地板；成本才是你拧的那个旋钮。

---

## 🩹 踩过的坑都焊进去了（省得你再踩）

这工具是真刀真枪跑 AI 开发流水线结的痂。几个塑造了它的淤青：

- **没完没了挑刺的陷阱。** 有一次审查卡了 **13 轮、约 80 分钟**还没过——AI 每轮都换着花样找*新的*小毛病（先是错别字，再是路径，又是命名……）。那种「同一个抱怨重复 3 次就停」的天真规则永远不触发，因为抱怨一直在*变*。所以 3rd-review 会盯着这种卡壳的苗头，直接转人工，而不是无限循环。

- **审查慢，慢在一个蠢原因上。** 我们测了一次审查：**343 秒、一百多万 token。** 结果发现大头根本不是*审查*——是 AI 每一轮都在重读那几个根本没变的规则文件。教训：优化前先测量，瓶颈几乎从不在你猜的地方。

- **「喂个描述就行」是行不通的。** 你要是给审查员一段总结，比如*「请审查我打算做 X 的方案」*，而不是真实的代码 diff，它就只会悄悄做个浅层检查。一定要喂**真实 diff**。

---

## ⚙️ 给工程师看的

<details>
<summary>点开展开：技术细节</summary>

**两个入口，一个大脑。** `standalone.sh` 是脱平台入口（大多数人用这个——干净环境、无 gate、走退出码契约）。`review-dispatch-adapter.sh` 是 agenthub 系统内部用的平台适配器（裁决落盘、受下游 gate 校验）——*不*在这个仓里。两者共享同一套路由逻辑和判定脚本。

**路由器是个纯函数。** [`scripts/route-review.mjs`](./scripts/route-review.mjs) 读一张数据表（[`config/route-rules.json`](./config/route-rules.json)），按内容类型 + 改动量 + 风险关键词决定审查档位。同入同出、没有藏着的状态——所以好测、可信。

**runner 契约。** 审查 runner 被这样调用：`{runner} --prompt-file=… --result-file=… --review-request-id=…`，必须往 `--result-file` 写一个 JSON 裁决，至少包含 `{"verdict": "pass"|"revise_required"|"escalate_to_human", "findings": [...]}`。裁决是 `pass` 时，standalone 会**强制要求**三个证据字段必须存在——`reviewSnapshot[]`、`riskDisposition[]`、`worktreeInventory`——缺任一就直接 fail-fast 升级人工。它只校验字段*存在且格式合法*，不判断审查员有没有把风险覆盖对；`riskDisposition` 绝不自动补（替主观判断回填等于伪造）。完整规范——含 standalone 与平台两路径的补填差异——见 [`references/pass-evidence-contract.md`](./references/pass-evidence-contract.md)。

**四条不可谈判的硬护栏**（任何档位都绕不过）：每轮覆盖改动行 ≥80%；高风险维度永远全审；缩范围审查只要有一条护栏不达标就立即回退全量；最终裁决永远必须来自独立上下文。

**怎么验证：**

```bash
npm test    # 路由核（纯函数）+ standalone 路径，零依赖
```

`npm test` 跑可移植测试集——纯函数路由器测试（`route-review`、`cost-compare`、`verdict-core-hash`，全用 `node:assert`）加上两个 standalone 集成测试。开箱即绿。*（仓库里其它 `*.test.mjs` / `*.test.ts` 耦合于 agenthub monorepo、只能在那里跑，作为参考随仓附带，不由 `npm test` 执行。）*

**仓库结构：**

```
SKILL.md                  # 编排 AI 读的薄壳
standalone.sh             # 脱平台入口（从这开始）
examples/codex-runner.sh  # 一个能跑、可照抄的审查 runner（包装 codex）
scripts/route-review.mjs   # 纯函数路由器——大脑
scripts/verdict-core-hash.mjs  # 防篡改哈希
config/route-rules.json    # 阈值的唯一权威源
references/                # 详细规则，按需加载
golden/  __fixtures__/     # 测试 fixture
```

</details>

---

<div align="center">

**独立性是地板。成本是旋钮。pass 必须拿出证据。**

*从一条真实多代理流水线的伤疤里长出来——也对自己保证不了什么很诚实。*

</div>
