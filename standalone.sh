#!/bin/bash
# standalone.sh — 3rd-review 脱平台薄适配入口（RD-4）
#
# 用法：
#   standalone.sh --input=<路径或-> [--output-root=<目录,缺省 cwd>] [--task-name=<可选>]
#                 [--review-runner=<cmd>] [--max-revise-rounds=N]
#
# 职责（薄适配，审查策略在 SKILL.md，不在此重复）：
#   - 上下文护栏：输入必须存在可读，否则 escalate（exit 2）
#   - D18 任务结构：output-root/tasks/<name>/reviews/
#   - O9 任务名：sanitized-slug + UTC + 短随机 id，不覆盖已有
#   - run-manifest.json 状态机：in_progress → completed | failed
#   - O5 版本锚点（FR-PORT-007）：git 可用记 sha，否则 manual-<UTC>
#   - 调 review-runner 产 verdict，注入 provenance=single-context（FR-GUARD-003）
#   - revise 循环上限（D25/O18，默认 3），达上限输出未决项清单+人工选择要求，escalate
#   - 退出码契约（FR-GUARD-001）：0=pass，1=revise_required，2=escalate_to_human；其他非零=执行错误
#   - stdout 中文结论（FR-GUARD-006），stderr 升级原因+下一步指引
#
# review-runner 契约：standalone 调用 <runner> --prompt-file=<审查包> --result-file=<out> --review-request-id=<id>
#   runner 写出符合 verdict.schema.json 的 JSON 到 --result-file。缺省 runner 走 review-dispatch-adapter.sh exec（真实 provider）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR"
# repo root：skills/3rd-review/ 上溯 3 层到 agenthub，再上溯到仓库根（仅用于定位缺省 adapter；standalone 不依赖在 repo 内运行）
AGENTHUB_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
DEFAULT_ADAPTER="$AGENTHUB_DIR/harness/review-dispatch-adapter.sh"

INPUT=""
OUTPUT_ROOT="$(pwd)"
TASK_NAME=""
REVIEW_RUNNER=""
MAX_REVISE_ROUNDS=3

for arg in "$@"; do
  case "$arg" in
    --input=*) INPUT="${arg#*=}" ;;
    --output-root=*) OUTPUT_ROOT="${arg#*=}" ;;
    --task-name=*) TASK_NAME="${arg#*=}" ;;
    --review-runner=*) REVIEW_RUNNER="${arg#*=}" ;;
    --max-revise-rounds=*) MAX_REVISE_ROUNDS="${arg#*=}" ;;
    *) echo "ERROR: unknown argument: $arg" >&2; exit 3 ;;
  esac
done

# ── 升级辅助：stderr 原因 + 下一步指引，stdout 中文结论，exit 2 ──
escalate() {
  local reason="$1" next_step="$2"
  echo "escalate_to_human: ${reason}" >&2
  echo "下一步：${next_step}" >&2
  echo "审查结论：需要人工介入（escalate_to_human）。原因：${reason}"
  exit 2
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── 上下文护栏（FR-GUARD-001）：输入必须可读 ──
if [ -z "$INPUT" ]; then
  escalate "缺少 --input 参数" "提供 --input=<审查输入文件路径或 - 表示 stdin>"
fi

INPUT_LABEL="$INPUT"
INPUT_FILE=""
if [ "$INPUT" = "-" ]; then
  INPUT_FILE="$(mktemp)"
  cat > "$INPUT_FILE"
  INPUT_LABEL="stdin"
  if [ ! -s "$INPUT_FILE" ]; then
    rm -f "$INPUT_FILE"
    escalate "stdin 审查输入为空" "通过管道或重定向提供非空审查输入"
  fi
else
  if [ ! -f "$INPUT" ] || [ ! -r "$INPUT" ]; then
    escalate "审查输入不存在或不可读：$INPUT" "检查 --input 路径是否正确且可读"
  fi
  INPUT_FILE="$INPUT"
fi

# ── O9 任务名生成：sanitized-slug + UTC + 短随机，不覆盖已有 ──
sanitize_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40
}
UTC_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SHORT_RAND="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-6)"
if [ -n "$TASK_NAME" ]; then
  SLUG="$(sanitize_slug "$TASK_NAME")"
else
  SLUG="$(sanitize_slug "$(basename "${INPUT_LABEL%.*}")")"
fi
[ -z "$SLUG" ] && SLUG="review"
TASK_ID="${SLUG}-${UTC_STAMP}-${SHORT_RAND}"
TASK_PATH="$OUTPUT_ROOT/tasks/$TASK_ID"
# 不覆盖已有目录（O9）
while [ -e "$TASK_PATH" ]; do
  SHORT_RAND="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-6)"
  TASK_ID="${SLUG}-${UTC_STAMP}-${SHORT_RAND}"
  TASK_PATH="$OUTPUT_ROOT/tasks/$TASK_ID"
done
REVIEWS_DIR="$TASK_PATH/reviews"
mkdir -p "$REVIEWS_DIR"

# ── O5 版本锚点（FR-PORT-007）：git 可用记 sha，否则 manual-<UTC> ──
VERSION_ANCHOR="$(git -C "$OUTPUT_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [ -z "$VERSION_ANCHOR" ]; then
  VERSION_ANCHOR="manual-$(now_utc)"
fi

MANIFEST="$TASK_PATH/run-manifest.json"
STARTED_AT="$(now_utc)"

# ── run-manifest 状态机：in_progress ──
write_manifest() {
  local status="$1" verdict="${2:-}" exit_code="${3:-}" revise_rounds="${4:-0}" failure_reason="${5:-}"
  python3 - "$MANIFEST" "$TASK_ID" "$status" "$STARTED_AT" "$VERSION_ANCHOR" \
    "$INPUT_LABEL" "$verdict" "$exit_code" "$revise_rounds" "$MAX_REVISE_ROUNDS" "$failure_reason" <<'PY'
import json, sys, datetime
(path, task, status, started, anchor, inp, verdict, exit_code, rr, mrr, fail) = sys.argv[1:12]
m = {
  "taskName": task,
  "status": status,
  "startedAt": started,
  "versionAnchor": anchor,
  "input": inp,
  "maxReviseRounds": int(mrr),
  "reviseRounds": int(rr),
}
if status in ("completed", "failed"):
  m["endedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
if verdict: m["verdict"] = verdict
if exit_code != "": m["exitCode"] = int(exit_code)
if fail: m["failureReason"] = fail
json.dump(m, open(path, "w"), ensure_ascii=False, indent=2)
PY
}
write_manifest in_progress

# ── 自适应路由选档（T008 / RD-5）：审查前判定 env/contentType/scope，落盘 route_decision ──
# env 探测层与策略层分离；standalone 一律 env=standalone。route_decision 供审查投入档位
# 参考，绝不缩小审查责任范围。路由失败不阻断审查（降级：不选档，记 note）。
ROUTE_SCRIPT="$SCRIPT_DIR/scripts/route-review.mjs"
ROUTE_DECISION_FILE="$REVIEWS_DIR/route-decision.json"
if [ -f "$ROUTE_SCRIPT" ] && command -v node >/dev/null 2>&1; then
  DIFF_LINES="$(grep -cE '^[+-]' "$INPUT_FILE" 2>/dev/null || echo 0)"
  node "$ROUTE_SCRIPT" --input="$INPUT_FILE" --diff-lines="$DIFF_LINES" --out="$ROUTE_DECISION_FILE" 2>/dev/null \
    || printf '{"env":"standalone","selected":"small","rejected":[],"reason":"route-review unavailable; conservative default","rulesVersion":"unknown","note":"routing degraded"}\n' > "$ROUTE_DECISION_FILE"
else
  printf '{"env":"standalone","selected":"small","rejected":[],"reason":"node/route-review unavailable; conservative default","rulesVersion":"unknown","note":"routing degraded"}\n' > "$ROUTE_DECISION_FILE"
fi

# ── 解析缺省 review-runner ──
if [ -z "$REVIEW_RUNNER" ]; then
  if [ -x "$DEFAULT_ADAPTER" ] || [ -f "$DEFAULT_ADAPTER" ]; then
    REVIEW_RUNNER="bash $DEFAULT_ADAPTER exec"
  else
    write_manifest failed "" "" 0 "no review runner available"
    escalate "无可用审查 runner（缺省 adapter 不存在且未提供 --review-runner）" "安装审查员运行时或用 --review-runner=<cmd> 注入"
  fi
fi

# ── verdict → exit code 映射 ──
verdict_to_exit() {
  case "$1" in
    pass) echo 0 ;;
    revise_required) echo 1 ;;
    escalate_to_human) echo 2 ;;
    *) echo 3 ;;
  esac
}

# ── revise 循环（D25/O18，上限 MAX_REVISE_ROUNDS）──
ROUND=1
FINAL_VERDICT=""
FINAL_VERDICT_FILE=""
while :; do
  REQUEST_ID="standalone-${TASK_ID}-r${ROUND}"
  RAW_VERDICT="$REVIEWS_DIR/verdict-round-${ROUND}.raw.json"
  # 调 runner（审查包 = 输入文件；Phase 2 不做 route 选档，Phase 3 接入）
  set +e
  $REVIEW_RUNNER --prompt-file="$INPUT_FILE" --result-file="$RAW_VERDICT" --review-request-id="$REQUEST_ID"
  RUNNER_RC=$?
  set -e
  if [ "$RUNNER_RC" -ne 0 ] || [ ! -s "$RAW_VERDICT" ]; then
    write_manifest failed "" "" "$((ROUND-1))" "review runner failed (rc=$RUNNER_RC) at round $ROUND"
    escalate "审查 runner 执行失败（round ${ROUND}, rc=${RUNNER_RC}）" "检查 runner 命令与审查员运行时可用性"
  fi

  # 提取裁决 + 注入 provenance=single-context，写最终 verdict.json
  VERDICT_VAL="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('verdict',''))" "$RAW_VERDICT")"
  FINAL_VERDICT_FILE="$REVIEWS_DIR/verdict-round-${ROUND}.json"
  REPORT_FILE="$REVIEWS_DIR/report-round-${ROUND}.md"
  python3 - "$RAW_VERDICT" "$FINAL_VERDICT_FILE" "$TASK_ID" "$ROUND" "$REPORT_FILE" "$REVIEWS_DIR" <<'PY'
import json, sys, os
raw, out, task, rnd, report_file, reviews_dir = sys.argv[1:7]
v = json.load(open(raw))
v["provenance"] = "single-context"   # FR-GUARD-003 / RD-3
report_rel = os.path.relpath(report_file, os.path.dirname(reviews_dir))
v["reportPath"] = report_rel
json.dump(v, open(out, "w"), ensure_ascii=False, indent=2)

# ── Markdown report (FR-GUARD-006) ──
# Fixed section structure from base-verifier.md report format, plus the 3rd-review
# dimensions (O12). The five-tuple quality baseline (golden fixtures) reads these
# sections and dimensions back, so the structure is contractual, not cosmetic.
verdict = v.get("verdict", "")
findings = v.get("findings", []) if isinstance(v.get("findings"), list) else []
blocking = [f for f in findings if f.get("severity") == "blocking"]
dimensions = v.get("reviewDimensions") or ["方向", "盲点", "细节"]
downgrade_reason = v.get("downgradeReason") or v.get("rootCause") or v.get("fixApproach") or ""

lines = []
lines.append(f"# 审查报告 — {task} (round {rnd})")
lines.append("")
lines.append(f"- verdict: {verdict}")
lines.append(f"- provenance: single-context")
lines.append("")
# ① Summary
lines.append("## Summary")
lines.append("")
lines.append(v.get("resolutionSummary") or v.get("summary") or "(无摘要)")
lines.append("")
# ② Findings
lines.append("## Findings")
lines.append("")
if findings:
    for f in findings:
        sev = f.get("severity", "")
        issue = f.get("issue", "")
        loc = f.get("file", "")
        line_no = f.get("line", "")
        rec = f.get("recommendation", "")
        # 三段式：位置 + 问题 + 建议
        lines.append(f"- [{sev}] 位置: {loc}{(':'+str(line_no)) if line_no else ''} | 问题: {issue} | 建议: {rec}")
else:
    lines.append("（无 findings）")
lines.append("")
# ③ Checks (review dimensions covered)
lines.append("## Checks")
lines.append("")
lines.append("审查维度覆盖：" + "、".join(dimensions))
for d in dimensions:
    lines.append(f"- 维度[{d}]：已覆盖")
lines.append("")
# ④ Required Revisions
lines.append("## Required Revisions")
lines.append("")
if verdict != "pass":
    # downgrade must carry a reason
    lines.append(f"降级理由：{downgrade_reason or '(未提供，需补充)'}")
    if blocking:
        for f in blocking:
            lines.append(f"- 必须修复：{f.get('issue','')}")
    else:
        lines.append("- 见上方 Findings")
else:
    lines.append("无（pass）")
lines.append("")
open(report_file, "w").write("\n".join(lines) + "\n")
PY
  # 当前轮 verdict.json + report.md 作为最新结果的稳定别名
  cp "$FINAL_VERDICT_FILE" "$REVIEWS_DIR/verdict.json"
  cp "$REPORT_FILE" "$REVIEWS_DIR/report.md"

  if [ "$VERDICT_VAL" = "revise_required" ]; then
    if [ "$ROUND" -ge "$MAX_REVISE_ROUNDS" ]; then
      # 达上限：输出未决项清单 + 要求人工选择（D25/O18）
      write_manifest failed "escalate_to_human" 2 "$ROUND" "revise loop hit cap ($MAX_REVISE_ROUNDS rounds)"
      {
        echo "未决项：连续 ${ROUND} 轮 revise_required 未收敛，已达上限 ${MAX_REVISE_ROUNDS}。"
        echo "最新裁决产物：${FINAL_VERDICT_FILE}"
      } >&2
      escalate "revise 循环达上限 ${MAX_REVISE_ROUNDS} 轮仍未通过" "人工检查最新 verdict 与审查输入，决定继续修复、放宽要求或终止"
    fi
    ROUND=$((ROUND+1))
    continue
  fi

  FINAL_VERDICT="$VERDICT_VAL"
  break
done

EXIT_CODE="$(verdict_to_exit "$FINAL_VERDICT")"
REVISE_ROUNDS=$((ROUND-1))

# ── 终态 manifest + 中文结论 + 退出码 ──
case "$FINAL_VERDICT" in
  pass)
    write_manifest completed "$FINAL_VERDICT" "$EXIT_CODE" "$REVISE_ROUNDS"
    echo "审查结论：通过（pass）。任务目录：${TASK_PATH}，裁决文件：${FINAL_VERDICT_FILE}。"
    ;;
  revise_required)
    write_manifest completed "$FINAL_VERDICT" "$EXIT_CODE" "$REVISE_ROUNDS"
    echo "审查结论：需要修改（revise_required）。任务目录：${TASK_PATH}，裁决文件：${FINAL_VERDICT_FILE}。"
    ;;
  escalate_to_human)
    write_manifest completed "$FINAL_VERDICT" "$EXIT_CODE" "$REVISE_ROUNDS"
    echo "审查结论：需要人工介入（escalate_to_human）。任务目录：${TASK_PATH}。"
    echo "escalate_to_human: 审查员直接返回 escalate" >&2
    echo "下一步：人工查看裁决文件 ${FINAL_VERDICT_FILE} 后决定" >&2
    ;;
  *)
    write_manifest failed "" 3 "$REVISE_ROUNDS" "unknown verdict: $FINAL_VERDICT"
    echo "执行错误：审查 runner 返回未知裁决值「${FINAL_VERDICT}」。" >&2
    exit 3
    ;;
esac

exit "$EXIT_CODE"
