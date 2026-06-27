#!/usr/bin/env bash
# skill-metadata.test.sh — Phase 3 metadata assertions + T3-4 AC-6 runtime smoke
#
# Tests:
#   T3-1: SKILL.md metadata (trigger words, no agenthub terms, section presence)
#   T3-1: ~/.claude/skills/3rd-review.md existence, standalone.sh reference, executable
#   T3-4: AC-6 runtime smoke — real heterologous backend call via standalone.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_MD="$SKILL_DIR/SKILL.md"
GLOBAL_SKILL="$HOME/.claude/skills/3rd-review.md"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL+1)); }

echo "=== skill-metadata.test.sh ==="
echo ""

# ── T3-1 Metadata assertions ──

# 1. SKILL.md exists
if [ -f "$SKILL_MD" ]; then
  pass "SKILL.md exists"
else
  fail "SKILL.md not found at $SKILL_MD"
fi

# 2. SKILL.md HAS a "触发词" section
if grep -q "触发词" "$SKILL_MD"; then
  pass "SKILL.md contains '触发词' section"
else
  fail "SKILL.md missing '触发词' section"
fi

# 3. SKILL.md contains "审查" and "review" as trigger examples
if grep -q "审查" "$SKILL_MD"; then
  pass "SKILL.md contains trigger word '审查'"
else
  fail "SKILL.md missing trigger word '审查'"
fi

if grep -q "review" "$SKILL_MD"; then
  pass "SKILL.md contains trigger word 'review'"
else
  fail "SKILL.md missing trigger word 'review'"
fi

# 4. SKILL.md does NOT contain checkpoint_request
if grep -q "checkpoint_request" "$SKILL_MD" 2>/dev/null; then
  fail "SKILL.md contains 'checkpoint_request' (must be removed)"
else
  pass "SKILL.md has no 'checkpoint_request'"
fi

# 5. SKILL.md does NOT contain review-dispatch-adapter
if grep -q "review-dispatch-adapter" "$SKILL_MD" 2>/dev/null; then
  fail "SKILL.md contains 'review-dispatch-adapter' (must be removed)"
else
  pass "SKILL.md has no 'review-dispatch-adapter'"
fi

# 6. SKILL.md does NOT contain task-dir (as agenthub concept)
if grep -q "task-dir" "$SKILL_MD" 2>/dev/null; then
  fail "SKILL.md contains 'task-dir' (must be removed)"
else
  pass "SKILL.md has no 'task-dir'"
fi

# ── T3-3 assertions (global skill file) ──

# 7. ~/.claude/skills/3rd-review.md exists
if [ -f "$GLOBAL_SKILL" ]; then
  pass "~/.claude/skills/3rd-review.md exists"
else
  fail "~/.claude/skills/3rd-review.md not found"
fi

# 8. skill file references standalone.sh
if [ -f "$GLOBAL_SKILL" ] && grep -q "standalone.sh" "$GLOBAL_SKILL"; then
  pass "global skill file references standalone.sh"
else
  fail "global skill file missing standalone.sh reference"
fi

# 9. The referenced standalone.sh path is executable
if [ -f "$GLOBAL_SKILL" ]; then
  STANDALONE_PATH="$(grep -oE '/[^ ]+/standalone\.sh' "$GLOBAL_SKILL" | head -1)"
  if [ -n "$STANDALONE_PATH" ] && [ -x "$STANDALONE_PATH" ]; then
    pass "standalone.sh at referenced path is executable"
  elif [ -n "$STANDALONE_PATH" ]; then
    fail "standalone.sh at '$STANDALONE_PATH' exists but is NOT executable"
  else
    fail "could not extract standalone.sh path from global skill file"
  fi
else
  echo "SKIP: standalone.sh executable check (global skill file missing)"
fi

# ── T3-4 AC-6 runtime smoke ──

echo ""
echo "--- T3-4 AC-6 runtime smoke ---"

SMOKE_DIR="/tmp/p3-smoke"
rm -rf "$SMOKE_DIR"

# Run standalone.sh with --skip-manifest against golden input.
# standalone.sh may exit non-zero (e.g. 2 for escalate_to_human, 1 for revise_required).
# verdict.json is still written regardless — the stable alias at reviews/verdict.json.
set +e
bash "$SKILL_DIR/standalone.sh" --skip-manifest --input="$SKILL_DIR/golden/simple-text/input.md" --output-root="$SMOKE_DIR" > /tmp/p3-smoke-stdout.txt 2> /tmp/p3-smoke-stderr.txt
SMOKE_RC=$?
set -e

echo "standalone.sh exit code: $SMOKE_RC"

# Find verdict JSON (stable alias written at reviews/verdict.json)
VFILE=$(ls "$SMOKE_DIR/tasks"/*/reviews/verdict.json 2>/dev/null | head -1)

if [ -z "$VFILE" ]; then
  fail "AC-6: no verdict.json produced in $SMOKE_DIR/tasks/*/reviews/"
  echo "SMOKE stdout above may contain error details"
else
  pass "AC-6 element 1: verdict.json produced at $VFILE"

  # Element 2: provider present, non-empty, != "same-source"
  node -e "
const v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
if(v.degraded==='same-source'){console.error('AC-6 element 2 unproven: backend degraded to same-source');process.exit(1);}
if(!v.provider){console.error('AC-6 element 2 unproven: provider field absent');process.exit(1);}
console.log('AC-6 element 2: provider='+v.provider)
" "$VFILE"
  EC_E2=$?
  if [ "$EC_E2" -eq 0 ]; then
    pass "AC-6 element 2: heterologous backend confirmed (provider present, not same-source)"
  else
    fail "AC-6 element 2: heterologous backend NOT confirmed (degraded or no provider)"
  fi

  # Element 3: verdict JSON valid with verdict or verdict_status non-empty
  node -e "
const v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
if(!v.verdict_status&&!v.verdict){console.error('AC-6 element 3 FAIL: no verdict_status or verdict field');process.exit(1);}
console.log('AC-6 element 3: verdict_status='+(v.verdict_status||v.verdict))
" "$VFILE"
  EC_E3=$?
  if [ "$EC_E3" -eq 0 ]; then
    pass "AC-6 element 3: verdict field present and non-empty"
  else
    fail "AC-6 element 3: verdict field absent or empty"
  fi

  # Element 4: anti-forgery annotation for lightweight mode (FR-FORGE-002)
  node -e "
const v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
if(!v['anti-forgery']||v['anti-forgery']!=='lightweight (no-manifest)'){console.error('AC-6 element 4 FAIL: anti-forgery field absent or wrong (got '+JSON.stringify(v['anti-forgery'])+')');process.exit(1);}
console.log('AC-6 element 4: anti-forgery='+v['anti-forgery'])
" "$VFILE"
  EC_E4=$?
  if [ "$EC_E4" -eq 0 ]; then
    pass "AC-6 element 4: anti-forgery=lightweight (no-manifest) present (FR-FORGE-002)"
  else
    fail "AC-6 element 4: anti-forgery=lightweight (no-manifest) NOT present (FR-FORGE-002)"
  fi
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
