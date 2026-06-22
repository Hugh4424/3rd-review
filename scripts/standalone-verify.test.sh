#!/usr/bin/env bash
# standalone-verify.test.sh — T006 golden five-tuple comparison over the standalone path
#
# For each of the 8 golden cases, this:
#   1. builds a per-case stub review-runner that emits a verdict JSON carrying the
#      case's expected five-tuple (verdict + blocking findings + dimensions +
#      downgrade reason). This is the reproducible runner injection (plan RD-1 /
#      method A): the verdict content is fixed, so the comparison checks that the
#      standalone PIPELINE faithfully carries and renders all five quality-baseline
#      facets — it does NOT depend on provider login / network / LLM variance.
#   2. runs standalone.sh with that runner against the case input.md
#   3. extracts the ACTUAL five-tuple from standalone artifacts:
#        (1) verdict             <- reviews/verdict.json .verdict
#        (2) blockingCount/Titles<- reviews/verdict.json .findings[severity=blocking]
#        (3) requiredSections    <- reviews/report.md must contain every "## <section>"
#        (4) reviewDimensions    <- reviews/report.md Checks section must cover each dim
#        (5) downgradeReasonReq   <- verdict!=pass => report must carry a non-empty reason
#   4. compares ACTUAL vs expected.json. ANY missing/mismatched facet => case FAIL.
#
# Modes:
#   --list   structure-only scan (input.md + expected.json + five-tuple fields present)
#   --run    full five-tuple comparison over the standalone path (default)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GOLDEN_DIR="$SKILL_DIR/golden"
STANDALONE="$SKILL_DIR/standalone.sh"
EXPECTED_CASE_COUNT=9

NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && { echo "ERROR: node required" >&2; exit 1; }

# ── --list: structure-only validation (Phase 1 behavior, retained) ──
cmd_list() {
  echo "=== standalone-verify --list ==="
  local cases=() ; for d in "$GOLDEN_DIR"/*/; do [ -d "$d" ] && cases+=("$d"); done
  local total=${#cases[@]} fail=0
  for case_dir in "${cases[@]}"; do
    local name; name="$(basename "$case_dir")"
    local ok=1
    [ -f "$case_dir/input.md" ] || { echo "  [FAIL] $name — missing input.md"; ok=0; }
    [ -f "$case_dir/expected.json" ] || { echo "  [FAIL] $name — missing expected.json"; ok=0; }
    if [ "$ok" = 1 ]; then
      "$NODE_BIN" -e "
        const d=JSON.parse(require('fs').readFileSync('$case_dir/expected.json','utf8'));
        const req=['verdict','blockingCount','blockingTitles','requiredSections','reviewDimensions','downgradeReasonRequired'];
        const miss=req.filter(f=>!d.expected||!Object.prototype.hasOwnProperty.call(d.expected,f));
        if(miss.length){console.error('missing '+miss.join(','));process.exit(1)}
      " 2>/dev/null || { echo "  [FAIL] $name — five-tuple field(s) missing"; ok=0; }
    fi
    [ "$ok" = 1 ] && echo "  [PASS] $name" || fail=$((fail+1))
  done
  [ "$total" -ne "$EXPECTED_CASE_COUNT" ] && { echo "FAIL: expected $EXPECTED_CASE_COUNT cases, found $total" >&2; exit 1; }
  [ "$fail" -gt 0 ] && { echo "FAIL: $fail structural failures" >&2; exit 1; }
  echo "PASS: all $EXPECTED_CASE_COUNT cases structurally valid"
}

# ── per-case stub runner: emits verdict JSON carrying the expected five-tuple ──
make_case_stub() {
  local expected_json="$1" stub="$2"
  cat > "$stub" <<STUB
#!/bin/bash
set -euo pipefail
RESULT=""; RID=""
for a in "\$@"; do case "\$a" in --result-file=*) RESULT="\${a#*=}";; --review-request-id=*) RID="\${a#*=}";; esac; done
"$NODE_BIN" -e '
  const fs=require("fs");
  const exp=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected;
  const rid=process.argv[2], out=process.argv[3];
  const findings=(exp.blockingTitles||[]).map(t=>({severity:"blocking",issue:t,file:"review-input",recommendation:"fix per finding"}));
  const v={reviewRequestId:rid, verdict:exp.verdict, findings, reviewDimensions:exp.reviewDimensions};
  if(exp.verdict!=="pass") v.downgradeReason="降级理由：见 findings（"+exp.verdict+"）";
  if(exp.verdict==="pass") v.resolutionSummary="clean pass";
  fs.writeFileSync(out, JSON.stringify(v,null,2));
' "$expected_json" "\$RID" "\$RESULT"
STUB
  chmod +x "$stub"
}

# ── compare ACTUAL standalone artifacts vs expected five-tuple ──
compare_case() {
  local task_path="$1" expected_json="$2"
  local verdict_file="$task_path/reviews/verdict.json"
  local report_file="$task_path/reviews/report.md"
  [ -f "$verdict_file" ] || { echo "MISMATCH: verdict.json missing"; return; }
  [ -f "$report_file" ] || { echo "MISMATCH: report.md missing"; return; }
  "$NODE_BIN" -e '
    const fs=require("fs");
    const exp=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected;
    const v=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
    const report=fs.readFileSync(process.argv[3],"utf8");
    const bad=[];
    if(v.verdict!==exp.verdict) bad.push("verdict("+v.verdict+"!="+exp.verdict+")");
    const blk=(v.findings||[]).filter(f=>f.severity==="blocking");
    if(blk.length!==exp.blockingCount) bad.push("blockingCount("+blk.length+"!="+exp.blockingCount+")");
    const got=new Set(blk.map(f=>f.issue)), want=new Set(exp.blockingTitles||[]);
    for(const t of want) if(!got.has(t)) bad.push("missingBlockingTitle:"+t);
    for(const t of got) if(!want.has(t)) bad.push("extraBlockingTitle:"+t);
    for(const s of (exp.requiredSections||[])) if(!report.includes("## "+s)) bad.push("missingSection:"+s);
    for(const d of (exp.reviewDimensions||[])) if(!report.includes(d)) bad.push("missingDimension:"+d);
    // 3-part finding structure (location + issue + recommendation) for each blocking
    if(blk.length>0){
      const findingLines=report.split("\n").filter(l=>/^- \[blocking\]/.test(l));
      for(const l of findingLines){
        if(!(l.includes("位置:")&&l.includes("问题:")&&l.includes("建议:")))
          bad.push("findingNot3Part:"+l.slice(0,40));
      }
    }
    if(exp.downgradeReasonRequired){
      if(v.verdict==="pass") bad.push("downgradeReasonRequired but verdict=pass");
      else if(!/降级理由/.test(report)) bad.push("missingDowngradeReason");
    } else {
      if(v.verdict!=="pass") bad.push("downgradeReasonRequired=false but verdict!=pass");
    }
    if(bad.length){console.log("MISMATCH: "+bad.join("; "))} else {console.log("OK")}
  ' "$expected_json" "$verdict_file" "$report_file"
}

cmd_run() {
  echo "=== standalone-verify --run (five-tuple full comparison) ==="
  local cases=() ; for d in "$GOLDEN_DIR"/*/; do [ -d "$d" ] && cases+=("$d"); done
  local total=${#cases[@]} fail=0
  [ "$total" -ne "$EXPECTED_CASE_COUNT" ] && { echo "FAIL: expected $EXPECTED_CASE_COUNT cases, found $total" >&2; exit 1; }

  RUN_OUT_ROOT="$(mktemp -d)"
  RUN_STUB="$(mktemp)"
  trap 'rm -rf "${RUN_OUT_ROOT:-}" "${RUN_STUB:-}"' EXIT
  local out_root="$RUN_OUT_ROOT" stub="$RUN_STUB"

  for case_dir in "${cases[@]}"; do
    local name; name="$(basename "$case_dir")"
    local input="$case_dir/input.md" expected="$case_dir/expected.json"
    make_case_stub "$expected" "$stub"
    local case_root="$out_root/$name"; mkdir -p "$case_root"

    # standalone exit code is verdict-driven (0/1/2); the five-tuple comparison is
    # the contract, so we tolerate non-zero exit and assert on artifacts.
    set +e
    bash "$STANDALONE" --input="$input" --output-root="$case_root" --task-name="$name" --review-runner="$stub" >/dev/null 2>&1
    set -e
    local task_path; task_path="$(find "$case_root/tasks" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1)"
    if [ -z "$task_path" ]; then
      echo "  [FAIL] $name — standalone produced no task dir"; fail=$((fail+1)); continue
    fi
    local result; result="$(compare_case "$task_path" "$expected")"
    if [ "$result" = "OK" ]; then
      echo "  [PASS] $name"
    else
      echo "  [FAIL] $name — $result"; fail=$((fail+1))
    fi
  done

  echo ""
  echo "--- Summary: $((total-fail))/$total cases match five-tuple ---"
  [ "$fail" -gt 0 ] && { echo "FAIL: $fail case(s) failed five-tuple comparison" >&2; exit 1; }
  echo "PASS: all $EXPECTED_CASE_COUNT cases match the five-tuple quality baseline over the standalone path"
}

case "${1:---run}" in
  --list) cmd_list ;;
  --run) cmd_run ;;
  *) echo "Usage: $(basename "$0") [--list|--run]" >&2; exit 1 ;;
esac
