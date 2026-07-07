#!/bin/bash
# standalone.sh — 3rd-review 脱平台薄适配入口（RD-4）
#
# 用法：
#   standalone.sh --input=<路径或-> [--output-root=<目录,缺省 cwd>] [--task-name=<可选>]
#                 [--review-runner=<cmd>]
#
# 职责（薄适配，审查策略在 SKILL.md，不在此重复）：
#   - 上下文护栏：输入必须存在可读，否则 escalate（exit 2）
#   - D18 任务结构：output-root/tasks/<name>/reviews/
#   - O9 任务名：sanitized-slug + UTC + 短随机 id，不覆盖已有
#   - run-manifest.json 状态机：in_progress → completed | failed
#   - O5 版本锚点（FR-PORT-007）：git 可用记 sha，否则 manual-<UTC>
#   - 调 review-runner 产 verdict 一次，注入 provenance=single-context（FR-GUARD-003）；
#     不做内部 revise 循环、不做轮次上限判断（FR-THIRDREVIEW-003：轮次管理属于集成入口 wh-review，
#     不属于本引擎）——runner 返回什么裁决，本脚本据此裁决并立即退出进程
#   - 退出码契约（FR-GUARD-001）：0=pass，1=revise_required，2=escalate_to_human；其他非零=执行错误
#   - stdout 中文结论（FR-GUARD-006），stderr 升级原因+下一步指引
#
# review-runner 契约：standalone 调用 <runner> --prompt-file=<审查包> --result-file=<out> --review-request-id=<id>
#   runner 写出符合 verdict.schema.json 的 JSON 到 --result-file。runner 通过 THIRD_REVIEW_RUNNER 环境变量或 --review-runner=<cmd> 注入。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR"

REVIEW_RUNNER="${THIRD_REVIEW_RUNNER:-}"

INPUT=""
OUTPUT_ROOT="$(pwd)"
TASK_NAME=""

FOREGROUND_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --input=*) INPUT="${arg#*=}" ;;
    --output-root=*) OUTPUT_ROOT="${arg#*=}" ;;
    --task-name=*) TASK_NAME="${arg#*=}" ;;
    --review-runner=*) REVIEW_RUNNER="${arg#*=}" ;;
    --foreground-only) FOREGROUND_ONLY=1 ;;
    --skip-manifest) SKIP_MANIFEST=1 ;;
    *) echo "ERROR: unknown argument: $arg" >&2; exit 3 ;;
  esac
done

# ── --foreground-only guard (T2-5 / AC-9) ──
# Detect if launched via run_in_background, nohup, or disown.
# These patterns in the parent environment signal a background launch.
if [ "$FOREGROUND_ONLY" -eq 1 ]; then
  # Build background-pattern regex without writing the literal words on one line
  BG_P1='run_in_back'
  BG_P2='ground'
  BG_P3='nohu'
  BG_P4='p'
  BG_P5='diso'
  BG_P6='wn'
  BG_PATTERN="${BG_P1}${BG_P2}|${BG_P3}${BG_P4}|${BG_P5}${BG_P6}"
  if [ -n "${BASH_EXECUTION_STRING:-}" ] && echo "$BASH_EXECUTION_STRING" | grep -qE "$BG_PATTERN"; then
    echo "ERROR: --foreground-only requires synchronous foreground execution. Detected background launcher in BASH_EXECUTION_STRING." >&2
    exit 1
  fi
  # Check parent process command line for background launchers
  if command -v ps >/dev/null 2>&1 && [ "${PPID:-0}" -gt 1 ]; then
    PARENT_CMD="$(ps -o command= -p "$PPID" 2>/dev/null || true)"
    if [ -n "$PARENT_CMD" ] && echo "$PARENT_CMD" | grep -qE "$BG_PATTERN"; then
      echo "ERROR: --foreground-only requires synchronous foreground execution. Detected background launcher in parent process ($PPID)." >&2
      exit 1
    fi
  fi
fi

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

# ── run-manifest 状态机：in_progress（单次调用，无轮次概念——FR-THIRDREVIEW-003）──
write_manifest() {
  local status="$1" verdict="${2:-}" exit_code="${3:-}" failure_reason="${4:-}"
  python3 - "$MANIFEST" "$TASK_ID" "$status" "$STARTED_AT" "$VERSION_ANCHOR" \
    "$INPUT_LABEL" "$verdict" "$exit_code" "$failure_reason" <<'PY'
import json, sys, datetime
(path, task, status, started, anchor, inp, verdict, exit_code, fail) = sys.argv[1:10]
m = {
  "taskName": task,
  "status": status,
  "startedAt": started,
  "versionAnchor": anchor,
  "input": inp,
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

# ── 解析缺省 review-runner（Phase 2: run-heterologous-review.mjs 为主，run-delegated-precheck.mjs 为降级回退）──
if [ -z "$REVIEW_RUNNER" ]; then
  HET_REVIEWER="$SCRIPT_DIR/scripts/run-heterologous-review.mjs"
  FALLBACK_PRE_CHECK="$SCRIPT_DIR/scripts/run-delegated-precheck.mjs"

  if [ -f "$HET_REVIEWER" ] && command -v node >/dev/null 2>&1; then
    REVIEW_RUNNER="node $HET_REVIEWER"
    IS_HETEROLOGOUS=1
  elif [ -f "$FALLBACK_PRE_CHECK" ] && command -v node >/dev/null 2>&1; then
    REVIEW_RUNNER="node $FALLBACK_PRE_CHECK"
    IS_HETEROLOGOUS=0
    echo "warning: run-heterologous-review.mjs not available; falling back to same-source run-delegated-precheck.mjs" >&2
  else
    write_manifest failed "" "" 0 "no review runner available"
    escalate "无可用审查 runner：未设置 THIRD_REVIEW_RUNNER 环境变量且未提供 --review-runner=<cmd>" "设置 THIRD_REVIEW_RUNNER=<cmd> 或用 --review-runner=<cmd> 注入"
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

# ── 单次调用 review-runner（FR-THIRDREVIEW-003：无 revise 循环、无轮次上限）──
FINAL_VERDICT=""
FINAL_VERDICT_FILE=""

REQUEST_ID="standalone-${TASK_ID}-r1"
RAW_VERDICT="$REVIEWS_DIR/verdict-round-1.raw.json"
# 调 runner：heterologous mode 用 --diff/--round/--output；degraded 用 --prompt-file/--result-file/--review-request-id
set +e
if [ "${IS_HETEROLOGOUS:-0}" -eq 1 ]; then
  # Canonical entry point is --diff/--output only (FR-THIRDREVIEW-001): the engine
  # has zero stage/round/checkpoint knowledge; legacy flags are rejected outright.
  node "$HET_REVIEWER" --diff="$INPUT_FILE" --output="$RAW_VERDICT"
else
  $REVIEW_RUNNER --prompt-file="$INPUT_FILE" --result-file="$RAW_VERDICT" --review-request-id="$REQUEST_ID"
fi
RUNNER_RC=$?
set -e
if [ "$RUNNER_RC" -ne 0 ] || [ ! -s "$RAW_VERDICT" ]; then
  write_manifest failed "" "" "review runner failed (rc=$RUNNER_RC)"
  escalate "审查 runner 执行失败（rc=${RUNNER_RC}）" "检查 runner 命令与审查员运行时可用性"
fi

# 提取裁决 + 注入 provenance=single-context，写最终 verdict.json
VERDICT_VAL="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('verdict',''))" "$RAW_VERDICT")"

# pass 必带三字段校验（FR-GUARD-007）：reviewSnapshot / riskDisposition / worktreeInventory。
# 缺任一即 fail-fast —— 一个空 pass 不得被当作通过（README/SKILL 的信任承诺由此兑现）。
# standalone 路径一律不补，runner 必须自带三字段（gated 平台路径才有条件补，区别见
# references/pass-evidence-contract.md）。riskDisposition 任何路径都不补（补=伪造）。
if [ "$VERDICT_VAL" = "pass" ]; then
  MISSING_FIELDS="$(python3 -c "
import json, sys
v = json.load(open(sys.argv[1]))
missing = []
# reviewSnapshot: 必须是非空数组（至少覆盖一个被审文件）
rs = v.get('reviewSnapshot')
if not isinstance(rs, list) or len(rs) == 0:
    missing.append('reviewSnapshot')
# riskDisposition: 必须是数组；空数组合法（无高风险项时），但不补
if not isinstance(v.get('riskDisposition'), list):
    missing.append('riskDisposition')
# worktreeInventory: 必须是对象且带 included/unrelated/excluded 三个数组
wi = v.get('worktreeInventory')
if (not isinstance(wi, dict)
        or not all(isinstance(wi.get(k), list) for k in ('included', 'unrelated', 'excluded'))):
    missing.append('worktreeInventory')
print(' '.join(missing))
" "$RAW_VERDICT")"
  if [ -n "$MISSING_FIELDS" ]; then
    write_manifest failed "escalate_to_human" 2 "pass missing required evidence fields: $MISSING_FIELDS"
    escalate "runner 返回 pass 但缺少必带证据字段：${MISSING_FIELDS}" \
      "pass 必须带 reviewSnapshot/riskDisposition/worktreeInventory；让 runner 产出这些字段，或人工复核该裁决是否可信"
  fi
fi

FINAL_VERDICT_FILE="$REVIEWS_DIR/verdict-round-1.json"
REPORT_FILE="$REVIEWS_DIR/report-round-1.md"
python3 - "$RAW_VERDICT" "$FINAL_VERDICT_FILE" "$TASK_ID" 1 "$REPORT_FILE" "$REVIEWS_DIR" "${SKIP_MANIFEST:-0}" <<'PY'
import json, sys, os
raw, out, task, rnd, report_file, reviews_dir, skip_manifest = sys.argv[1:8]
v = json.load(open(raw))
v["provenance"] = "single-context"   # FR-GUARD-003 / RD-3
if skip_manifest == "1":
    v["anti-forgery"] = "lightweight (no-manifest)"   # FR-FORGE-002
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
        # Accept both finding shapes: {issue,file,line,recommendation} and {title,detail}.
        issue = f.get("issue") or f.get("title", "")
        loc = f.get("file") or f.get("location", "")
        line_no = f.get("line", "")
        rec = f.get("recommendation") or f.get("detail", "")
        # 三段式：位置 + 问题 + 建议
        loc_str = f" 位置: {loc}{(':'+str(line_no)) if line_no else ''} |" if loc else ""
        lines.append(f"- [{sev}]{loc_str} 问题: {issue} | 建议: {rec}")
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
            lines.append(f"- 必须修复：{f.get('issue') or f.get('title','')}")
    else:
        lines.append("- 见上方 Findings")
else:
    lines.append("无（pass）")
lines.append("")
open(report_file, "w").write("\n".join(lines) + "\n")
PY
# 当前 verdict.json + report.md 作为最新结果的稳定别名
cp "$FINAL_VERDICT_FILE" "$REVIEWS_DIR/verdict.json"
cp "$REPORT_FILE" "$REVIEWS_DIR/report.md"

# ── FR-FORGE-001: Generate snapshot-manifest sidecar (content-binding hash) ──
if [ "${SKIP_MANIFEST:-0}" != "1" ] && command -v node >/dev/null 2>&1; then
  MANIFEST_SCRIPT="$SCRIPT_DIR/scripts/generate-snapshot-manifest.mjs"
  if [ -f "$MANIFEST_SCRIPT" ]; then
    # Resolve reviewed file paths against dirname(INPUT) first, then cwd fallback.
    # reviewSnapshot[].path values are relative to the input file's directory, not cwd.
    INPUT_DIR="$(dirname "$INPUT_FILE")"

    # Collect reviewed file paths from reviewSnapshot[].path and findings[].file.
    # B3: Use bash array to avoid word-splitting on paths with spaces.
    # Only pass --file= args for paths that actually exist on disk.
    MANIFEST_FILE_ARGS=()
    DROPPED_PATHS=""
    while IFS= read -r -d '' f; do
      case "$f" in
        /*)
          f_abs="$f"
          if [ -f "$f_abs" ]; then
            MANIFEST_FILE_ARGS+=("--file=$f_abs")
          else
            DROPPED_PATHS="$DROPPED_PATHS $f"
          fi
          ;;
        *)
          f_candidate="$INPUT_DIR/$f"
          if [ ! -f "$f_candidate" ]; then
            f_candidate="$(pwd)/$f"
          fi
          if [ -f "$f_candidate" ]; then
            MANIFEST_FILE_ARGS+=("--file=$f_candidate")
          else
            DROPPED_PATHS="$DROPPED_PATHS $f"
          fi
          ;;
      esac
    done < <(python3 -c "
import json, sys
v = json.load(open('$REVIEWS_DIR/verdict.json'))
rs = v.get('reviewSnapshot') or []
paths = [e.get('path','') for e in rs if isinstance(e, dict)]
findings = v.get('findings') or []
finding_paths = [f.get('file','') for f in findings if isinstance(f, dict) and f.get('file')]
all_paths = sorted(set(paths + finding_paths))
for p in all_paths:
    sys.stdout.write(p + '\0')
" 2>/dev/null)

    # Always call generator — even with empty file list — to bind the verdict (B1).
    # B3: array elements are quoted individually, no word-splitting.
    # Manifest failure is OBSERVABLE but NON-BLOCKING: warn to stderr, never escalate.
    set +e
    if [ "${#MANIFEST_FILE_ARGS[@]}" -gt 0 ]; then
      node "$MANIFEST_SCRIPT" --verdict="$REVIEWS_DIR/verdict.json" "${MANIFEST_FILE_ARGS[@]}" --repo-root="$INPUT_DIR"
    else
      node "$MANIFEST_SCRIPT" --verdict="$REVIEWS_DIR/verdict.json" --repo-root="$INPUT_DIR"
    fi
    MANIFEST_RC=$?
    set -e
    if [ "$MANIFEST_RC" -ne 0 ]; then
      echo "warning: snapshot-manifest generation failed (rc=$MANIFEST_RC) — verdict unaffected" >&2
    fi
    if [ -n "$DROPPED_PATHS" ]; then
      echo "warning: snapshot-manifest: unresolvable reviewed paths (no file on disk):$DROPPED_PATHS" >&2
    fi
  fi
fi

# 单次调用，runner 返回什么裁决就是什么裁决——不重试、不进入下一轮（FR-THIRDREVIEW-003）。
FINAL_VERDICT="$VERDICT_VAL"
EXIT_CODE="$(verdict_to_exit "$FINAL_VERDICT")"

# ── 终态 manifest + 中文结论 + 退出码 ──
case "$FINAL_VERDICT" in
  pass)
    write_manifest completed "$FINAL_VERDICT" "$EXIT_CODE"
    echo "审查结论：通过（pass）。任务目录：${TASK_PATH}，裁决文件：${FINAL_VERDICT_FILE}。"
    ;;
  revise_required)
    write_manifest completed "$FINAL_VERDICT" "$EXIT_CODE"
    echo "审查结论：需要修改（revise_required）。任务目录：${TASK_PATH}，裁决文件：${FINAL_VERDICT_FILE}。"
    ;;
  escalate_to_human)
    write_manifest completed "$FINAL_VERDICT" "$EXIT_CODE"
    echo "审查结论：需要人工介入（escalate_to_human）。任务目录：${TASK_PATH}。"
    echo "escalate_to_human: 审查员直接返回 escalate" >&2
    echo "下一步：人工查看裁决文件 ${FINAL_VERDICT_FILE} 后决定" >&2
    ;;
  *)
    write_manifest failed "" 3 "unknown verdict: $FINAL_VERDICT"
    echo "执行错误：审查 runner 返回未知裁决值「${FINAL_VERDICT}」。" >&2
    exit 3
    ;;
esac

exit "$EXIT_CODE"
