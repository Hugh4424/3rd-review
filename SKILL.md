# 3rd-review — 自动审查分发（薄壳）

> 本文件是主会话读取的骨架。审查员/脚本执行时才用的细节在 `references/`，主会话不读，子代理/脚本按需读。
> 完整规则索引见末尾「references/ 资源索引」。

## 触发时机

每个 stage/phase 完成、需要触发审查时。

## 功能概述

自动完成全链路审查分发：checkpoint_request → 审查包构造（三类源 + Delta Package）→ 审查员独立审查 → JSON 落盘 → reviewer_output 门禁校验 → stage_advance。

两种使用场景共享同一套审查策略与判定脚本，只有环境差异收进两个薄适配入口：
- **agenthub 内（gated）**：主 agent 经 `checkpoint_request` 触发，走 `review-dispatch-adapter.sh`，落盘进 task 目录，受 gate 校验。
- **脱平台（standalone）**：干净环境审查代码/文档，无 gate、无 journal。入口 `skills/3rd-review/standalone.sh`。细节见 `references/standalone-usage.md`、`references/work-dir-contract.md`。

## 路由判定（权威分类器在 route-review.mjs，本节是决策序列）

审查方式（异源 R2/R1、同源 R6）的权威 level 枚举由 `scripts/route-review.mjs` 纯分类器产出，`review-dispatch-adapter.sh` 接线消费。发起任何审查前，按三步顺序决策，三步正交、不要混判：

**第 1 步 · 入口**（走不走 gated adapter）：
- **绑定活跃 gated task**（有 `checkpoint_request` 生成的 reviewRequestId + 本 task 的 task-dir）→ 走厚封装入口 `review-dispatch-adapter.sh`（gated，受 gate 校验）。
- **未绑定** → 不走 gated adapter。仅此而已——入口选择不决定审查方式（同源/异源），见第 2/3 步。
- 注：`standalone.sh` 默认 runner 委派给 gated adapter，因此对未绑定 task 的审查同样要求 task-dir/reviewReqId；除非显式注入不依赖 gated 身份的 `--review-runner`，否则别用它审未绑定 task 的改动。

**第 2 步 · 环境**（有没有外部 CLI）：
- 探测两个外部 CLI：`command -v codex` 和 `command -v gemini`（或其它异源审查工具）。
- **两个均失败**（`ENV_PROBE_RESULT=no_external_cli`）→ 降级 **R6 同源干净子代理**（Agent 工具，fresh 独立上下文，满足硬护栏 #4）。
- 有任一可用 → 进第 3 步。

**第 3 步 · 内容 + 进度**（异源 R2/R1 还是 R6）：
- **level 由分类器权威产出，薄壳不复述阈值**：把**真实 diff / 源文件 / 审查包**喂给 `route-review.mjs`（或 adapter），它按内容类型 + scope + 风险关键词产出 `RouteDecision.level`（R6/R2/R1）。薄壳不在此复述 medium/large 行数阈值与升档规则——那是代码职责，prose 复述必然与代码漂移。
- **喂料铁律（这步唯一要主 agent 记住的）**：必须喂真实 diff/源文件，**不要只喂"审查XX方案"自然语言描述**——纯文字会被分类器判成 text-record/small 而走 R6，这不是异源失败、是输入不对。纯文档/小改/trivial 本就该 R6，无需异源开销。**直接跑 `route-review.mjs` 时还必须传真实 `--diff-lines=N`**（默认 0 → code diff 被判 trivial → R6）；或只经会自动算行数的 adapter/standalone 入口，别裸调分类器漏传行数。
- **进度驱动降级**（多轮审查时）：首轮按分类器结果走（中等及以上异源）；后续轮次的降级判定由 `applyPostRoundDegradation` 按**上一轮 findings 数量 + 是否 blocking** 权威产出（详见 `references/verdict-dispatch.md`），薄壳不复述具体阈值。硬护栏任何形态不降级（FR-REVIEW-004/005）。

阈值与降级形态见 `scripts/route-review.mjs`、`references/execution-steps.md`、`references/delta-package-rules.md`「无 CLI 降级形态（FR-REVIEW-003）」、`references/verdict-dispatch.md`「动态升级规则」。

## 接线前置校验失败：先分清「走错路」还是「漏参数」，再决定停换路 vs 补参数

审查基础设施的**前置身份/接线校验失败**——典型信号：`requires --task-dir`、`missing reviewRequestId`、`unverifiable review identity`、`refusing to run`——出现时，先判断属于哪种情形，两者处置相反：

- **情形 A：未绑定活跃 gated task 却走了 gated 入口**（无 checkpoint_request、无本 task 的 task-dir，却调了 standalone/adapter 的 gated 路径）→ "审查入口选错"，**不是可重试的审查失败**。第一次出现就**停止**，回到上面三步路由序列（入口=未绑定就不走 adapter；方式按环境+内容档+进度判：docs-only/小改仍 R6，中等及以上首轮必须异源）。**禁止**为绕过该校验而合成临时 task-dir、伪造 reviewRequestId、包装假身份 runner 等 patch-retry 动作（既浪费，也破坏审查身份可验证性这一防伪前提）。
- **情形 B：本就在活跃 gated 流程里，只是参数遗漏**（确有 checkpoint_request / 本 task 的 task-dir，只是调用时漏传了 `--task-dir` 等真实参数）→ 普通参数 bug，正确做法是**补上真实参数重试**（用真实值，不是合成的），不要换路。
- 判别要点：缺的参数**有没有真实来源**。有真实 task-dir/checkpoint 可填 = B，补真值；根本没有、要靠造假才能填 = A，停下换路。
- 以上都与"审查员返回 revise_required/escalate"两回事：那是审查跑完后的真实裁决，本节说的是审查根本没跑起来。只有真实裁决进 verdict 分流。

## 厚封装入口（推荐，一行发起）

主管家用一行发起完整审查；adapter 内部原子完成 exec（provider 命令 + AJV 校验）→ persist（落盘 + 报告），对外只暴露 `{verdict, reportPath, evidencePaths}`。

```bash
# 步骤 A（前台，秒级）：准备 prompt + result 文件。
PROMPT_FILE=$(mktemp /tmp/3rd-review-prompt-XXXXXX); echo "$PROMPT" > "$PROMPT_FILE"
RESULT_FILE=$(mktemp /tmp/3rd-review-result-XXXXXX.json)

# 步骤 B（用 run_in_background:true 发起，必须是这一条 bash 命令、不拼任何尾随命令）：
#   审查结果写入 RESULT_FILE；adapter review 子命令的真实退出码即本命令退出码（被 task-notification 如实报告）。
bash packages/core/agenthub/harness/review-dispatch-adapter.sh review \
  --prompt-file="$PROMPT_FILE" --result-file="$RESULT_FILE" \
  --checkpoint-id="<checkpoint-id>" --round="<round>" \
  --task-dir=<TASK_DIR> --workflow=<workflow-id> \
  --reviewer-role="reviewer" --reviewer-runtime-id="<runtime-id>" --reviewer-provider="<provider>"

# 步骤 C（命令 exit 自动唤起后，前台）：三条件校验通过后再消费 RESULT_FILE，最后清理 PROMPT_FILE。
```

- 后台执行硬规则：审查命令用 Bash 工具 `run_in_background: true` 发起（detached、跨 turn、exit 时自动唤起主 agent）。**该后台 Bash 调用必须只含审查命令这一条,不得拼接任何尾随命令(`; rm`/`&& ...`/`| ...`/`find` 等),也不得用 `RESULT=$(...)` 命令替换捕获**——否则 task-notification 报告的退出码是尾随命令(或被命令替换吞掉的外层赋值)的 0,而非审查命令真实退出码,会把 escalate(exit 2)误判为成功。审查结果写入 `--result-file`。命令 exit 后做三条件硬校验——①进程真 exit ②RESULT_FILE 完整可 parse（verdict/findings 字段齐全）③exit code=0——全满足才进 persist，任一不满足则前台长 timeout（≥1500000ms）重跑。**verdict 以 RESULT_FILE 内容为准,exit code 仅作辅助信号**。被动 `Command running in background`（未主动声明而被 harness 踢后台）仍按失败处理。
- 执行失败时输出 `{"verdict":"failed",...}` 并 exit 0，主流程不中断。
- 审查包构造、Source Manifest、Delta Package、子审查器并行预审、prompt 拼装等细节见 `references/delta-package-rules.md`、`references/execution-steps.md`、`references/reviewer-prompt-assembly.md`。

## 子代理派发指引

无外部 CLI（R6 降级）时走干净子代理审查：子代理以全新独立上下文运行（不继承主会话历史），接收完整 reviewer-contract + verifier prompt，硬护栏不降级，输出格式与外部 CLI 路径一致。provenance 枚举与降级形态硬要求见 `references/reviewer-prompt-assembly.md`、`references/execution-steps.md`。

## intake 路由映射表（checkpoint-id 前缀 → required skills）

| checkpoint-id 前缀 | required skills |
|---|---|
| `design-review` | plan-ceo-review, review, plan-design-review |
| `plan-review` | speckit-analyze, plan-eng-review, review |
| `test-acceptance-review` | qa-only, verify-change |
| `intake-direction-review` | plan-ceo-review, review |
| `intake-detail-review` | review |

verifier prompt/contract 选择表、Design Sources 必读表见 `references/execution-steps.md`。

## 三字段要求（pass verdict 必带）

pass 必须含三字段（语义与 persist 补填规则见 `references/verdict-dispatch.md`）：
- `reviewSnapshot[]`：每个被审文件 `path/gitHead/mtime/hash`（客观，coverage 承载）。
- `riskDisposition[]`：每个高风险项 `risk/checkedSource/decision/whyNotBlocking`（主观，persist 不补，缺则 fail-fast）。
- `worktreeInventory`：`included/unrelated/excluded` 路径数组（客观）。

三字段均在 verdict-core-hash 白名单外，persist 补填不破 `_execNonce` 防伪校验。

## 升级口诀

审查轮次不设固定上限；升级判定在审查器技能层做出，不依赖 workflow engine 计数器。重复未解决的同一 blocking finding（同文件/同类别/同核心描述）累积到阈值 → `escalate_to_human`，说明需人工介入。每轮先查根因再修复，切换审查形态不等于松护栏。完整动态升级规则（含确切阈值、根因先行、形态切换约束）见 `references/verdict-dispatch.md`。

## 硬护栏层（任何形态不可绕过）

1. 最低回归覆盖：每轮覆盖本 phase 全部 changed files 的 ≥80% 改动行。
2. 强制审高风险维度：high-risk 部分必须完整审查，不可降级抽查。
3. 失败回退全量：缩范围审查任一护栏不满足 → 立即 `fallback_full_scope`。
4. 独立性保证：最终 verdict 必须由独立上下文产出，禁止主 agent 自审自判。

缩范围补偿机制、Delegated Trust 优先级、delegated precheck 强制性见 `references/delta-package-rules.md`、`references/execution-steps.md`。

## verdict 分流（pass / revise_required / escalate_to_human）

- `pass` → `post_review_required`，先做 post-pass 留存（host 自动写 feedback/summary journal）+ `post_review_pass` gate，才能 `stage_advance`。pass 不是完成态。
- `revise_required` → `review_intake_required`，走修复循环（receiving-code-review → review-intake → TDD 重采 → 下一轮）。
- `escalate_to_human` → 停止，输出升级原因等人工。

完整分流步骤、post-pass 顺序、修复循环 8 项 gate 检查、审查执行证明、审查员验证门禁见 `references/verdict-dispatch.md`、`references/exec-proof.md`、`references/verifier-gate.md`。

## 红旗自检（STOP — 出现即停，别合理化）

发起/执行审查时，以下动作出现任一即停，不要找理由绕过（多数历史上真实发生过，是各节硬停的聚合自检入口，不替代原文细则）：

- **伪造身份**：为过身份校验合成临时 task-dir / 伪造 reviewRequestId / 包装假身份 runner（详见「接线前置校验失败」节）。
- **后台命令污染**：后台审查命令拼尾随命令（`; rm` / `&& ...` / `| ...` / `find`）或用 `RESULT=$(...)` 命令替换捕获——会吞真实退出码，把 escalate(exit 2) 误判成功（详见「厚封装入口」节）。
- **执行层绕过**：用 `--delegated-precheck=off` 跳过执行校验 / 主 agent 手写 review JSON 绕过 atomic persist 链路（exec-proof.md 2026-06-12 绕过事件）。
- **破坏独立性**：主 agent 自审自判 / 跳过独立上下文产出 verdict（硬护栏 #4）。
- **把 pass 当完成态**：pass 后仍须走 post-pass 留存 + `post_review_pass` gate 才能 `stage_advance`；pass verdict 必带三字段（reviewSnapshot/riskDisposition/worktreeInventory），缺则 fail-fast。
- **缩范围不回退**：缩范围审查任一护栏不满足 → 立即 `fallback_full_scope`，不得以缩范围方式通过。
- **喂料/路由误降级**：只喂"审查XX方案"文字描述不喂真实 diff（误降 R6）；未绑定 task 就默认 R6、不探测 CLI（环境有异源却走同源）。

---

## references/ 资源索引

主会话只读本薄壳。以下资源由子代理/脚本/审查员按需读取（不进主会话上下文，§6 move-map 标 M）：

| references 文件 | 内容 | move-map |
|---|---|---|
| `references/standalone-usage.md` | 脱平台使用场景（D12） | M |
| `references/work-dir-contract.md` | 通用契约：work-dir 抽象 | M |
| `references/input-guard.md` | 输入护栏（D17） | M |
| `references/delta-package-rules.md` | Delta Package 构造规则 + 缩范围护栏补偿 + 两层结构 | M |
| `references/execution-steps.md` | 执行步骤 0-4：required skills 预检 / Design Sources / Worktree Inventory / Host-Verified Facts / 子审查器并行预审 | M |
| `references/reviewer-prompt-assembly.md` | 步骤 4 prompt 拼装 + Runtime Preferences + DISPATCH MODE OVERRIDE（含 provenance 枚举与降级形态硬要求） | M |
| `references/exec-proof.md` | 审查执行证明（tamper-evident，`_execNonce` + reviewRecordHash） | M |
| `references/verdict-dispatch.md` | 步骤 6 verdict 分流 + post-pass 动作 + 动态升级规则（含升级阈值、根因先行、硬护栏交叉引用） | M |
| `references/verifier-gate.md` | 审查员验证门禁（防绕过，FR-REVIEW-012） | M |
