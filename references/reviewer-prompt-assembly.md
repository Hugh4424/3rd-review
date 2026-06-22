# 步骤 4：审查员独立审查 — prompt 拼装 + Runtime Preferences + DISPATCH MODE OVERRIDE + 厚封装调用面

> 本文件由 3rd-review SKILL.md 薄壳引用，主会话不读，审查员/脚本按需读。

## provenance 枚举要求（输出契约）

审查员产出 JSON 的 `provenance` 字段必须使用 verdict schema 枚举值：`"single-context"` / `"independent-subagent"` / `"independent-session"`。无 CLI 降级走干净子代理审查时，子代理路径必须使用 `"independent-subagent"`；任何不在枚举内的值会被 schema 校验拒绝。降级形态的完整行为约束见 `references/delta-package-rules.md` 的「无 CLI 降级形态（FR-REVIEW-003）」节。

### 步骤 4：审查员独立审查

拼装 prompt：Verifier Instructions（短入口 + 路径清单） + Runtime Preferences（模型/思考强度配置） + Inline Package（phase-scoped Design Sources） + Delta Package（diff + hunk context，非大文件全文） + Source Manifest + Current Worktree Inventory + Preflight Signals + Required Read Set + Standards Sources（路径清单） + reviewRequestId。第 2+ 轮额外附带前轮 findings 完整 JSON 作闭合核对（见 Delta Package 规则）。

**每一轮都是完整独立审查**：每轮（含 round 2+）都是对本 checkpoint 完整责任域的 COMPLETE, INDEPENDENT review。Delta Package 用 diff + hunk context 替代大文件全文内联：小文件（≤24KB）可全文内联；大文件（>80KB）禁止默认全文内联，只传 diff + hunk 上下文 + Required Read Set。这不缩小审查范围——见下方 Full-review rule。

#### 4a. Runtime Preferences（运行配置）

在写入 `PROMPT_FILE` 前，必须解析本轮运行配置并把 JSON 摘要追加进 prompt。解析优先级：

1. adapter 显式参数：`--model` / `--effort` / `--config-file`
2. 用户配置：`$AGENTHUB_REVIEW_DISPATCH_CONFIG` 或 `~/.agenthub/review-dispatch-config.json`
3. repo 临时默认配置：`packages/core/agenthub/config/review-dispatch-default.json`

解析命令：

```bash
RUNTIME_CONFIG_JSON=$(node packages/core/agenthub/skills/3rd-review/scripts/resolve-review-runtime-config.mjs \
  --role=reviewer --round="<round>")
```

prompt 中追加：

```text
## Runtime Preferences
<RUNTIME_CONFIG_JSON>

Reviewer MUST use reviewer.model / reviewer.thinking_level as the requested reviewer runtime. If reviewer.model is empty, omit the model flag and let the system default apply.
review-dispatch-adapter MUST run delegated precheck before final reviewer execution.
Subreviewers MUST use subreviewer.model / subreviewer.thinking_level.
Do not ask the final reviewer to produce runtime metadata fields. The adapter
will attach authoritative subreviewerRuntimeReports, delegatedReviewBundle,
and recommendedFinalReadSet after the final verdict JSON is returned.
The final reviewer MUST produce finalVerifierReadSet itself as the actually
inspected source targets for this verdict.
```

在 prompt 末尾追加 DISPATCH MODE OVERRIDE。**此段覆盖所有 verifier prompt 中的文件写入、index 追加、skill 调用规则**：

```
## DISPATCH MODE OVERRIDE
You are running as a reviewer via 3rd-review.
The following overrides ALL conflicting rules from the verifier prompts above:

- Return ONLY valid JSON matching verdict.schema.json. No other output. Do NOT output markdown.
- Do NOT write any files. Do NOT create verifier-reports/ files.
- Do NOT append to verifier-report-index.md.
- Do NOT append to reviews.jsonl.
- Ignore all "输出落盘规则" / "输出铁律" sections. Persistence is handled by 3rd-review after you return JSON.
- Exception: you MAY create temporary files under /tmp only for reviewer-side sub-agent execution, and MUST remove them before returning the final JSON.

**Language rule (CRITICAL)**: ALL JSON string values MUST be in English only. No Chinese characters, no Unicode quotes, no non-ASCII in any JSON field. This is a machine-parsing requirement — Chinese characters inside JSON strings break the pipeline. The markdown report will be generated separately with Chinese localization for human readability.

**Required skills ARE available** in your skills directory. Execute them in read-only verifier mode. Depending on checkpoint kind these include: `plan-ceo-review`, `plan-design-review`, `speckit-analyze`, `plan-eng-review`, `qa-only`, `verify-change`, `review` (see the checkpoint→required-skills mapping in `references/execution-steps.md`).
  - Try the Skill tool first when available.
  - If Skill tool execution fails, read the skill's SKILL.md from the first existing path: `~/.codex/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`, `packages/core/agenthub/skills/<name>/SKILL.md`.
  - Apply the lens's checklist/dimensions to the review sources.
  - Record key findings in skillResults with status="executed" and evidence strings (in English). If SKILL.md fallback was used, set mode to include `skill-file fallback`. Evidence MUST contain three elements: (1) where executed (session location or SKILL.md fallback path); (2) specific input/checkpoint checked; (3) conclusion/finding. Hollow summaries ("ran skill, no issues") are rejected (FR-REVIEW-006/007).
  - If a skill is not applicable to this review, set status="not_applicable" with reason in evidence

**Review rules**: (1) Read >=80% of modified code lines from each changed file. (2) Every finding must cite file + line + code snippet. (3) Blocking findings must describe the online-triggered symptom. (4) First round must list ALL blocking issues at once — 首轮请列全所有 blocking，避免挤牙膏式返修。Surface every blocking finding in round 1; do NOT hold back issues for later rounds. (5) When uncertain, bias towards revise_required. (6) EVERY finding MUST carry a `blockerClass` field, one of: `delivery_quality` (real delivery-quality defect, MAY be blocking) / `process_evidence` (process/evidence/format issue, MUST NOT be blocking — downgrade to important/minor) / `output_contract` (output-contract issue, severity per impact). Missing `blockerClass` makes the report fail-fast (FR-CLASS-001). `process_evidence` + `blocking` is a forbidden combination (FR-CLASS-002). (7) 后续轮（round≥2）新增的 blocking 必须标注漏查原因 `missedInPreviousRoundReason`（为何上轮未发现）。In round 2+, any NEW blocking finding that did not appear in the previous round MUST include a `missedInPreviousRoundReason` field explaining why it was missed (e.g., source not read, scope misunderstanding, new evidence surfaced). Omitting this field on a new-in-round-N blocking finding is itself a protocol violation.

**Delegated review is mandatory**: The prompt includes a `Delegated Review Bundle` generated by `review-dispatch-adapter.sh` before you were started. You MUST read the bundle, independently verify high-risk items, and use it as evidence input only. You remain the only final verdict owner. If the bundle is missing, return `escalate_to_human` with a finding explaining that delegated precheck was not executed.

**Runtime configuration**: The adapter records authoritative `_delegatedPrecheck`, `subreviewerRuntimeReports`, `delegatedReviewBundle`, and `recommendedFinalReadSet` after the reviewer returns. The final reviewer MUST NOT write, summarize, replace, or invent these runtime metadata fields. The final reviewer MUST output `finalVerifierReadSet` with the source targets it actually inspected.

**Pass evidence binding**: A pass MUST include `reviewSnapshot[]` for every reviewed file (`path`, `gitHead`, `mtime`, `hash`), `riskDisposition[]` for every delegated high risk (`risk`, `checkedSource`, `decision`, `whyNotBlocking`), and `worktreeInventory` with `included`, `unrelated`, and `excluded` path arrays. Current Worktree Inventory cannot be summary-only: list dirty unrelated/excluded paths and why they do not affect this checkpoint.

Pass-field semantics (maintainer note — NOT injected to the reviewer): The reviewer is required to PRODUCE all three pass fields (see the binding line above); persist-side autofill is a host safety-net, never a license for the reviewer to skip them. The three fields differ in nature and in how persist treats a missing field on a pass:

- `reviewSnapshot[]` — OBJECTIVE, but coverage-bearing. If a pass omits it, persist autofills ONLY when the reviewer's `finalVerifierReadSet` exists, and the snapshot path-set is derived FROM that readset (it is a coverage attestation — the path-set can never be invented from git status); per-path `gitHead`/`mtime`/`hash` are computed from disk. With no readset the field is NOT autofilled — persist fail-fasts naming `reviewSnapshot` (no empty skeleton).
- `worktreeInventory` — OBJECTIVE, not a coverage claim. If a pass omits it, persist autofills it from `git status` (git is a legitimate source here, unlike for the snapshot path-set).
- `riskDisposition[]` — SUBJECTIVE. Persist NEVER autofills it; a pass that omits it fail-fasts naming `riskDisposition`.

All three fields sit OUTSIDE the verdict-core-hash whitelist, so persist autofill does not break the `_execNonce` anti-forgery check.

**Full-review rule (CRITICAL — applies to EVERY round, including round 2+)**: Each round is a COMPLETE, INDEPENDENT review of this checkpoint's full responsibility SCOPE, NOT a narrow re-check. The scope invariant is absolute and is never narrowed by any round, any prior finding, or the Delegated Trust exception below. "Full review" means full-SCOPE coverage at a tiered READING DEPTH (see the Delegated Trust exception) — it does NOT mean inline-reading every byte of every file, and it does NOT require the prompt to inline every source file. You MUST cover the inline package, every Required Read Set item, and any Source Manifest file needed to judge correctness, at the reading depth its risk tier demands. Even on later rounds you MUST surface ANY issue you find — new or old. Verifying that prior-round findings are closed is an ADDITIONAL check layered on top of the full-scope review; it must NEVER replace or narrow it. A round-2 pass with zero findings is only valid if the full responsibility scope was genuinely reviewed at the correct depth and no issue was found. If any required source cannot be read, return escalate_to_human.

**Delegated Trust exception (READING-EFFORT optimization WITHIN full-scope review, NOT a scope exception)**: This exception tiers only the READING DEPTH per block — it operates inside the Full-review rule above and never narrows its scope invariant. Apply these tiers across the full scope:

| Risk tier | Block trigger | Required reading depth |
|---|---|---|
| 高危 / high-risk | touched by a high-risk item, candidate finding, forbidden/core/scope-boundary rule, or your own suspicion | MUST read in FULL — never sampled |
| 中危 / medium-risk | in scope, no high-risk trigger | browse / skim |
| 低危 / low-risk | in the bundle's `coverageAccepted` (already covered by subreviewers) | MAY apply base-verifier sampling fallback (sample a fraction; escalate to full re-read on ANY sampling mismatch) |

The sampling fallback ONLY reduces redundant reading effort on 低危 coverageAccepted sources — it does NOT narrow the round's full responsibility scope and does NOT exempt any 高危 block. When in doubt about a block's tier, treat it as 高危 and read in full. A pass still requires that the full responsibility scope was genuinely reviewed at these depths.

**No spawning narrowed subtasks**: Do NOT spawn sub-agents with task descriptions that pre-state "the revision summary" or limit scope to "verify whether prior finding X is closed". Any sub-agent you spawn must receive the checkpoint responsibility scope, Source Manifest, Required Read Set, and full-review mandate, not a narrowed confirmation task.

**Non-code review skill execution**: For design/plan/test-acceptance reviews, the reviewer MUST attempt to execute required skills. The execution order: (1) Try `Skill("<name>")` to invoke the skill directly. (2) If that fails (common in headless/read-only environments where skills require AskUserQuestion or file output), fall back by reading the skill's SKILL.md from the first existing path: `~/.codex/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`, `packages/core/agenthub/skills/<name>/SKILL.md`. Extract the review dimensions/lens from SKILL.md and apply those dimensions independently to the review sources. (3) Record results in `skillResults`: status=`executed` if either direct Skill execution or SKILL.md fallback succeeded, mode includes `skill-file fallback` when fallback was used, and status=`failed` only if both approaches failed. This fallback pattern works for ANY skill without per-skill configuration. Skill results are input to your review, not final verdict — only findings matching the checkpoint's reviewer contract blocking list can be marked blocking; non-matching findings MUST be downgraded to important/minor. If a required skill is unavailable and its SKILL.md cannot be read at all → escalate_to_human.

Output format (English-only JSON):
{"reviewRequestId":"<id>","verdict":"pass|revise_required|escalate_to_human","reviewSnapshot":[{"path":"...","gitHead":"...","mtime":"...","hash":"..."}],"riskDisposition":[{"risk":"...","checkedSource":"...","decision":"not_blocking|blocking","whyNotBlocking":"..."}],"worktreeInventory":{"included":[{"path":"...","reason":"..."}],"unrelated":[{"path":"...","reason":"..."}],"excluded":[{"path":"...","reason":"..."}]},"skillResults":[...],"verificationResults":[{"command":"<command or evidence read>","exitCode":0,"evidence":"<path or host fact>"}],"findings":[{"severity":"blocking|important|minor","blockerClass":"delivery_quality|process_evidence|output_contract","file":"...","line":0,"issue":"...","impact":"...","recommendation":"..."}]}
```

### 厚封装调用面（推荐入口）

主管家用一行发起完整审查，单一入口、内部原子完成审查执行与持久化，对外只暴露 verdict + reportPath + evidencePaths。调用方不感知内部分步，无需手动分别执行。

```bash
# 步骤 A（前台，秒级）：准备 prompt + result 文件
PROMPT_FILE=$(mktemp /tmp/3rd-review-prompt-XXXXXX); echo "$PROMPT" > "$PROMPT_FILE"
RESULT_FILE=$(mktemp /tmp/3rd-review-result-XXXXXX.json)

# 步骤 B（用 run_in_background:true 发起，必须只含这一条命令——
#   禁止拼尾随命令、禁止用 RESULT=$(...) 捕获，否则会掩盖真实退出码，详见 SKILL.md 红旗自检 / execution-steps.md）：
bash <path-to>/review-dispatch-adapter.sh review \
  --prompt-file="$PROMPT_FILE" --result-file="$RESULT_FILE" \
  --checkpoint-id="<checkpoint-id>" --round="<round>" \
  --task-dir=<TASK_DIR> --workflow=<workflow-id> \
  --reviewer-role="reviewer" --reviewer-runtime-id="<runtime-id>" --reviewer-provider="<provider>"

# 步骤 C（命令退出唤起后，前台）：三条件校验通过后再从 RESULT_FILE 读裁决，最后清理 PROMPT_FILE
VERDICT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).verdict)" "$RESULT_FILE")
REPORT_PATH=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).reportPath)" "$RESULT_FILE")
rm -f "$PROMPT_FILE"
```

- `review-dispatch-adapter.sh review` → 原子封装：exec（provider 命令 + AJV 校验）→ persist（落盘 + 报告）→ 输出 `{"verdict":"...","reportPath":"...","evidencePaths":[...]}` JSON
- 内部分步面（厚封装已代办，仅诊断时直调）：`exec` 用 `--result-file` 把审查员 stdout 捕获到结果文件（`RESULT_FILE=$(mktemp ...)`），再由 `review-persist.sh` 读该 RESULT_FILE 落盘并生成报告。厚封装对外只暴露 `--prompt-file`，`--result-file` / `RESULT_FILE` 由 adapter 内部管理。
- 执行失败时输出 `{"verdict":"failed","checkpoint":"...","round":N,"error":"..."}` 并 exit 0，主流程不中断
- 超时/retry 由 adapter 内部处理（`REVIEW_TIMEOUT_SECONDS` 环境变量可覆盖，默认 600s）；host Bash 工具外层 timeout 推荐 1500000ms

**关键变更**：review-persist.sh 不再自动执行 stage_advance。verdict 分流后由主 agent 执行后续动作：

- reviewer_output(verdict=pass) → state.currentStatus = `post_review_required`
- reviewer_output(verdict=revise_required) → state.currentStatus = `review_intake_required`
- reviewer_output(verdict=escalate_to_human) → state.currentStatus = `escalated`

`pass` 只表示审查通过；它不是完成态。pass 后必须先处于 `post_review_required`，完成 post-pass 留存和 `post_review_pass` 后才能 `stage_advance`。

3. 审查实现元数据落盘路径契约：

- Markdown：`<task-dir>/reports/<checkpoint-id>-<N>.md`
- Raw JSON：`<task-dir>/reviews/<checkpoint-id>/round-<N>.json`（含 `_codexMeta`）
- Metrics JSON：`<task-dir>/reviews/<checkpoint-id>/round-<N>.metrics.json`

渲染规则由 `render-views.ts` 保证；`subreviewer_meta` 未记录时报告显示”子代理明细：未记录”，不得伪造拆分值。

---

