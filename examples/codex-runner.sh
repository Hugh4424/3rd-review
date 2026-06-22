#!/usr/bin/env bash
# examples/codex-runner.sh — a minimal, real review-runner for `standalone.sh`.
#
# It demonstrates the runner contract: standalone calls
#   <runner> --prompt-file=<review package> --result-file=<out.json> --review-request-id=<id>
# and the runner must write a verdict JSON to --result-file.
#
# This one drives an *independent* engine (OpenAI `codex`) so the review is
# cross-source — the whole point of 3rd-review. Swap the `codex exec` call for a
# `gemini` / other CLI to build your own runner; the contract is all that matters.
#
# Verdict JSON shape this writes:
#   {
#     "reviewRequestId": "<id>",
#     "verdict": "pass" | "revise_required" | "escalate_to_human",
#     "findings": [...],
#     "resolutionSummary": "...",
#     // on pass, the three evidence fields standalone enforces:
#     "reviewSnapshot": [{ "path", "gitHead", "mtime", "hash" }, ...],
#     "riskDisposition": [...],   // [] is valid when there are no high-risk items
#     "worktreeInventory": { "included": [...], "unrelated": [...], "excluded": [...] }
#   }
#
# Requirements: `codex` on PATH, `python3` for JSON assembly.
set -euo pipefail

PROMPT_FILE=""; RESULT_FILE=""; REQUEST_ID=""
for arg in "$@"; do
  case "$arg" in
    --prompt-file=*)        PROMPT_FILE="${arg#*=}" ;;
    --result-file=*)        RESULT_FILE="${arg#*=}" ;;
    --review-request-id=*)  REQUEST_ID="${arg#*=}" ;;
    *) echo "codex-runner: unknown argument: $arg" >&2; exit 3 ;;
  esac
done

[ -n "$PROMPT_FILE" ] && [ -r "$PROMPT_FILE" ] || { echo "codex-runner: --prompt-file missing/unreadable" >&2; exit 3; }
[ -n "$RESULT_FILE" ] || { echo "codex-runner: --result-file required" >&2; exit 3; }
command -v codex  >/dev/null 2>&1 || { echo "codex-runner: 'codex' not found on PATH" >&2; exit 4; }
command -v python3 >/dev/null 2>&1 || { echo "codex-runner: 'python3' not found on PATH" >&2; exit 4; }

# Ask the independent engine to review the package and answer with a single JSON
# object. We pin the schema in the instruction so the model returns parseable output.
INSTRUCTION='You are an independent code/document reviewer. Read the review package below and return ONE JSON object only (no prose, no code fences) with exactly these keys:
- "verdict": one of "pass", "revise_required", "escalate_to_human".
- "findings": array; each {"severity":"blocking"|"minor","title":string,"detail":string}.
- "resolutionSummary": one-line string.
- On "pass" ONLY, also include:
  - "reviewSnapshot": array of {"path":string,"gitHead":string,"mtime":number,"hash":string} for every file you reviewed (objective coverage proof).
  - "riskDisposition": array of {"risk":string,"checkedSource":string,"decision":string,"whyNotBlocking":string}; use [] if there were no high-risk items.
  - "worktreeInventory": {"included":[...],"unrelated":[...],"excluded":[...]}.
Be strict: only return "pass" if you genuinely found nothing blocking.

=== REVIEW PACKAGE ==='

RAW_FILE="$(mktemp /tmp/codex-runner-raw-XXXXXX)"
trap 'rm -f "$RAW_FILE"' EXIT
{ printf '%s\n\n' "$INSTRUCTION"; cat "$PROMPT_FILE"; } | codex exec --skip-git-repo-check - >"$RAW_FILE" 2>/dev/null

# Extract the JSON object from codex output (it may wrap it in text/fences) and
# normalize it: stamp the reviewRequestId. The engine output is read from a file
# (never interpolated into Python source) — no injection or quoting hazard.
python3 - "$RESULT_FILE" "$REQUEST_ID" "$RAW_FILE" <<'PY'
import json, sys

result_file, request_id, raw_file = sys.argv[1], sys.argv[2], sys.argv[3]
with open(raw_file, encoding="utf-8", errors="replace") as f:
    raw = f.read()

# Find the first decodable top-level {...} object. raw_decode understands JSON
# string/escape semantics, so braces inside string values don't fool it.
def extract_json(text):
    dec = json.JSONDecoder()
    i = text.find("{")
    while i != -1:
        try:
            obj, _ = dec.raw_decode(text[i:])
            return obj
        except json.JSONDecodeError:
            i = text.find("{", i + 1)
    return None

v = extract_json(raw)
if v is None:
    # Could not parse a verdict — escalate rather than fake a pass.
    v = {"verdict": "escalate_to_human",
         "findings": [],
         "resolutionSummary": "codex-runner: could not parse a JSON verdict from the engine output"}

v["reviewRequestId"] = request_id

# Deliberately NO backfill of the three pass fields. If the engine returned a
# 'pass' but omitted reviewSnapshot / riskDisposition / worktreeInventory, we
# pass that gap straight through — standalone will fail-fast and escalate. A
# runner that auto-fills them would be forging evidence (an empty riskDisposition
# is itself a subjective "no high-risk items" judgement only the reviewer may make).

with open(result_file, "w") as f:
    json.dump(v, f, ensure_ascii=False, indent=2)
PY

exit 0
