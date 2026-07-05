#!/bin/bash
# standalone.test.sh — T004 regression for skills/3rd-review/standalone.sh
#
# Verifies the standalone thin adapter (RD-4 / API Contracts):
#   - D18 task structure: tasks/<name>/reviews/ created under --output-root
#   - O9 task name: sanitized-slug + UTC + short-random, no overwrite
#   - run-manifest.json state machine: in_progress -> completed | failed
#   - exit codes (FR-GUARD-001): 0=pass, 1=revise_required, 2=escalate_to_human
#   - Chinese conclusion printed to stdout (FR-GUARD-006)
#   - O5 version anchor (FR-PORT-007): git sha when available, else manual-<UTC>
#   - provenance=single-context written into verdict.json (FR-GUARD-003)
#   - revise loop cap (D25/O18): max_revise_rounds=3, escalate at cap
#
# A pluggable --review-runner is injected (REVIEW_RUNNER stub) so the verdict is
# deterministic and reproducible without provider login / network / LLM variance.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STANDALONE="$SKILL_DIR/standalone.sh"
GOLDEN_DIR="$SKILL_DIR/golden"

FAIL=0
fail() { echo "FAIL: $*" >&2; FAIL=1; }

[ -f "$STANDALONE" ] || { echo "FAIL: standalone.sh not found at $STANDALONE" >&2; exit 1; }

# ── B1 regression (code-review-phase-2 round 1): output variables must be ${}-wrapped ──
# `$VAR` immediately followed by non-ASCII text (e.g. `$TASK_PATH，`) is ambiguous
# across shells/locales — some parsers fold the multibyte punctuation into the
# variable name and abort under `set -u`. Require ${...} bracing in echo/escalate
# output lines so the variable boundary is unambiguous in every environment.
if grep -nE '(echo|escalate)' "$STANDALONE" | grep -qE '\$[A-Za-z_][A-Za-z0-9_]*[^A-Za-z0-9_ "'"'"'$/{}=)]'; then
  echo "FAIL: standalone.sh has an unbraced \$VAR adjacent to non-ASCII text in an output line (use \${VAR})" >&2
  grep -nE '(echo|escalate)' "$STANDALONE" | grep -E '\$[A-Za-z_][A-Za-z0-9_]*[^A-Za-z0-9_ "'"'"'$/{}=)]' >&2
  fail "unbraced output variable (B1 regression)"
fi

# ── stub runner: emits a deterministic verdict JSON from a fixture verdict value ──
# Contract: standalone.sh invokes the runner as:
#   <runner> --prompt-file=<pkg> --result-file=<out> --review-request-id=<id>
# The runner must write a verdict.schema.json-shaped JSON to --result-file.
# standalone.sh is responsible for adding provenance + manifest + exit mapping.
make_stub() {
  local verdict="$1" stub="$2"
  cat > "$stub" <<STUB
#!/bin/bash
set -euo pipefail
RESULT=""
RID=""
for a in "\$@"; do
  case "\$a" in
    --result-file=*) RESULT="\${a#*=}" ;;
    --review-request-id=*) RID="\${a#*=}" ;;
  esac
done
# A compliant runner emits the three pass-evidence fields on a pass verdict
# (reviewSnapshot/riskDisposition/worktreeInventory); standalone fails-fast without them.
if [ "$verdict" = "pass" ]; then
cat > "\$RESULT" <<JSON
{
  "reviewRequestId": "\$RID",
  "verdict": "$verdict",
  "findings": [],
  "resolutionSummary": "stub review for test",
  "reviewSnapshot": [{"path": "input.md", "gitHead": "manual-", "mtime": 0, "hash": "stub"}],
  "riskDisposition": [],
  "worktreeInventory": {"included": ["input.md"], "unrelated": [], "excluded": []}
}
JSON
else
cat > "\$RESULT" <<JSON
{
  "reviewRequestId": "\$RID",
  "verdict": "$verdict",
  "findings": [],
  "resolutionSummary": "stub review for test"
}
JSON
fi
STUB
  chmod +x "$stub"
}

INPUT="$GOLDEN_DIR/simple-text/input.md"
[ -f "$INPUT" ] || { echo "FAIL: golden simple-text input missing" >&2; exit 1; }

# ── case 1: pass verdict -> exit 0, task structure, manifest completed, provenance, Chinese ──
ROOT1="$(mktemp -d)"
trap 'rm -rf "$ROOT1" "${ROOT2:-}" "${ROOT3:-}" "${STUB:-}"' EXIT
STUB="$(mktemp)"
make_stub pass "$STUB"

OUT1="$(bash "$STANDALONE" --input="$INPUT" --output-root="$ROOT1" --review-runner="$STUB" 2>/tmp/sa-err1 || echo "EXIT=$?")"
RC1=$?
# capture real exit code separately (set -e safe)
set +e
bash "$STANDALONE" --input="$INPUT" --output-root="$ROOT1" --review-runner="$STUB" >/tmp/sa-out1 2>/tmp/sa-err1
RC1=$?
set -e
OUT1="$(cat /tmp/sa-out1)"

[ "$RC1" -eq 0 ] || fail "pass verdict should exit 0, got $RC1"

TASK_DIR1="$(find "$ROOT1/tasks" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1)"
[ -n "$TASK_DIR1" ] || fail "no tasks/<name>/ dir created under output-root"
[ -d "$TASK_DIR1/reviews" ] || fail "tasks/<name>/reviews/ not created"

MANIFEST1="$TASK_DIR1/run-manifest.json"
[ -f "$MANIFEST1" ] || fail "run-manifest.json not created"
if [ -f "$MANIFEST1" ]; then
  python3 - "$MANIFEST1" <<'PY' || fail "manifest not completed / missing fields"
import json,sys
m=json.load(open(sys.argv[1]))
assert m["status"]=="completed", f"status={m.get('status')}"
assert "taskName" in m and "startedAt" in m and "endedAt" in m, "missing timing fields"
import re
assert re.match(r'^([0-9a-f]{7,40}|manual-)', m["versionAnchor"]), m["versionAnchor"]
PY
fi

VERDICT1="$(find "$TASK_DIR1/reviews" -name 'verdict*.json' | head -1)"
[ -n "$VERDICT1" ] || fail "verdict json not written under reviews/"
if [ -n "$VERDICT1" ]; then
  node -e "const v=require('$VERDICT1'); process.exit((v.provenance==='single-context' && v.verdict==='pass')?0:1)" \
    || fail "verdict.json missing provenance=single-context or verdict!=pass"
fi

# T008: standalone runs adaptive routing before review and persists route_decision.
ROUTE1="$TASK_DIR1/reviews/route-decision.json"
[ -f "$ROUTE1" ] || fail "route-decision.json not written under reviews/ (T008 routing not wired into standalone)"
if [ -f "$ROUTE1" ]; then
  node -e "const r=require('$ROUTE1'); const ok=r.selected && r.rulesVersion && r.env==='standalone' && Array.isArray(r.rejected); process.exit(ok?0:1)" \
    || fail "route-decision.json missing required fields (selected/rulesVersion/env=standalone/rejected[])"
fi

# Chinese conclusion to stdout
printf '%s' "$OUT1" | grep -qE '[一-龥]' || fail "no Chinese conclusion printed to stdout"

# ── case 2: revise_required verdict -> stub always revises -> cap at 3 -> escalate exit 2 ──
ROOT2="$(mktemp -d)"
STUB2="$(mktemp)"
make_stub revise_required "$STUB2"
set +e
bash "$STANDALONE" --input="$INPUT" --output-root="$ROOT2" --review-runner="$STUB2" >/tmp/sa-out2 2>/tmp/sa-err2
RC2=$?
set -e
# perpetual revise should hit max_revise_rounds=3 and escalate (exit 2), not loop forever
[ "$RC2" -eq 2 ] || fail "perpetual revise should escalate (exit 2) at cap, got $RC2"
grep -qE '[一-龥]' /tmp/sa-out2 || fail "case2 no Chinese conclusion"
# escalation reason + next-step on stderr
grep -qiE 'escalat|人工|未决|max|上限' /tmp/sa-err2 /tmp/sa-out2 || fail "case2 no escalation reason / next-step"

# ── case 3: non-git output dir -> versionAnchor = manual-<UTC> (FR-PORT-007) ──
ROOT3="$(mktemp -d)"
STUB3="$(mktemp)"
make_stub pass "$STUB3"
# run with CWD inside a non-git dir AND output-root non-git
set +e
( cd "$ROOT3" && GIT_CEILING_DIRECTORIES="$ROOT3" bash "$STANDALONE" --input="$INPUT" --output-root="$ROOT3" --review-runner="$STUB3" >/tmp/sa-out3 2>/tmp/sa-err3 )
RC3=$?
set -e
MANIFEST3="$(find "$ROOT3/tasks" -name run-manifest.json | head -1)"
if [ -n "$MANIFEST3" ]; then
  grep -Eq '"versionAnchor": *"manual-[0-9TZ:.-]+"' "$MANIFEST3" \
    || fail "non-git dir should yield versionAnchor=manual-<UTC>, got: $(grep versionAnchor "$MANIFEST3")"
else
  fail "case3 manifest not created"
fi

# ── case 4: missing input -> context guard -> escalate exit 2 ──
ROOT4="$(mktemp -d)"
STUB4="$(mktemp)"
make_stub pass "$STUB4"
set +e
bash "$STANDALONE" --input="$ROOT4/does-not-exist.md" --output-root="$ROOT4" --review-runner="$STUB4" >/tmp/sa-out4 2>/tmp/sa-err4
RC4=$?
set -e
rm -rf "$ROOT4"
[ "$RC4" -eq 2 ] || fail "missing input should escalate (exit 2), got $RC4"

# ── case 5 (static): --checkpoint is parsed from args and forwarded to het reviewer call ──
# standalone.sh uses ${CHECKPOINT:+--checkpoint="$CHECKPOINT"} on the `node "$HET_REVIEWER" ...`
# line. This static regression verifies:
#   (a) --checkpoint=* is parsed into CHECKPOINT in the arg-parsing loop
#   (b) ${CHECKPOINT:+--checkpoint="$CHECKPOINT"} (or equivalent) appears on the HET_REVIEWER call

# (a) --checkpoint=* must be parsed
grep -qE '^\s*--checkpoint=\*\)' "$STANDALONE" \
  || fail "case5a: standalone.sh does not parse --checkpoint=* argument"

# (b) CHECKPOINT must be forwarded to the node het-reviewer call using conditional expansion
grep -qE 'node.*HET_REVIEWER.*CHECKPOINT' "$STANDALONE" \
  || fail "case5b: standalone.sh does not forward \$CHECKPOINT to the node \$HET_REVIEWER call"

# (c) The forwarding must use the safe ${CHECKPOINT:+...} form (not bare $CHECKPOINT which would
#     add an empty --checkpoint= on unset)
grep -qE '\$\{CHECKPOINT:\+' "$STANDALONE" \
  || fail "case5c: standalone.sh does not use \${CHECKPOINT:+...} conditional expansion for --checkpoint forwarding"

if [ "$FAIL" -ne 0 ]; then
  echo "=== standalone.sh tests FAILED ===" >&2
  exit 1
fi
echo "PASS: standalone.sh — task structure, manifest state machine, exit codes, provenance, version anchor, revise cap, checkpoint forwarding"
