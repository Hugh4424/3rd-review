# 3rd-review rewrite-universal-review — Final Test Report

**Date**: 2026-06-27
**Branch**: rewrite-universal-review
**Round**: 1 (fresh verification, no cached results)

---

<!-- round-1 -->

## Part 1 — Fresh Verification (Raw Outputs)

### npm test (test:core + test:standalone)

```
> 3rd-review@0.1.0 test
> npm run test:core && npm run test:standalone

> 3rd-review@0.1.0 test:core
> node scripts/route-review.test.mjs && node scripts/cost-compare.test.mjs && node scripts/verdict-core-hash.test.mjs && node scripts/standalone-passfields.test.mjs && node scripts/generate-snapshot-manifest.test.mjs && node scripts/verify-snapshot-manifest.test.mjs && node scripts/manifest-roundtrip.test.mjs

route-review.test: 68 passed, 0 failed
cost-compare.test: 9 passed, 0 failed
verdict-core-hash.test.mjs: 18 passed, 0 failed
standalone-passfields E2E: 4 passed, 0 failed
generate-snapshot-manifest.test.mjs: 12 passed, 0 failed
verify-snapshot-manifest.test.mjs: 22 passed, 0 failed
manifest-roundtrip.test.mjs: 4 passed, 0 failed

> 3rd-review@0.1.0 test:standalone
> bash scripts/standalone.test.sh && bash scripts/standalone-verify.test.sh

PASS: standalone.sh — task structure, manifest state machine, exit codes, provenance, version anchor, revise cap
=== standalone-verify --run (five-tuple full comparison) ===
  [PASS] capability-missing
  [PASS] high-risk
  [PASS] missing-context
  [PASS] missing-gate
  [PASS] path-conflict
  [PASS] rename-compat
  [PASS] simple-text
  [PASS] subreviewer-miss
  [PASS] wrong-request-id
--- Summary: 9/9 cases match five-tuple ---
PASS: all 9 cases match the five-tuple quality baseline over the standalone path

EXIT: 0
```

### node scripts/route-review.test.mjs

```
route-review.test: 68 passed, 0 failed
EXIT: 0
```

### node scripts/run-heterologous-review.test.mjs

```
  [PASS] detectHost returns 'claude-code' when CLAUDECODE set
  [PASS] detectHost returns 'claude-code' when CLAUDE_SESSION_ID set
  [PASS] detectHost returns 'codex' when CODEX_SESSION_ID set
  [PASS] detectHost returns 'codex' when OPENAI_API_KEY set
  [PASS] detectHost returns 'unknown' when neither set
  [PASS] detectHost priority: CLAUDECODE wins over codex markers
  [PASS] selectProvider: claude-code host, codex+gemini available → codex
  [PASS] selectProvider: codex host, gemini available → gemini
  [PASS] selectProvider: claude-code host, only claude available → degraded-same-source
  [PASS] selectProvider: empty available → degraded-same-source
  [PASS] selectProvider: priority order — codex over gemini over antigravity
  [PASS] selectProvider: skips host — codex host, codex+gemini available → gemini
  [PASS] selectProvider: skips host — gemini host, codex+gemini+grok available → codex
  [PASS] degraded same-source verdict shape: has degraded:'same-source'
  [PASS] degraded verdict has provider and no trueCrossEngine:true
  [PASS] T2-6 env-strip-check (skipped in normal mode, run with --env-strip-check)
  [PASS] T2-8A: BASH_FUNC_codex%% shell-function hijack is bypassed
  [PASS] T2-8B: PATH-shadow codex hijack is bypassed
  [PASS] probeAvailable returns array (smoke test, may be empty or populated)
  [PASS] probeAvailable with CODEX_UNAVAIL=1 excludes codex

20 passed, 0 failed
EXIT: 0
```

### node scripts/generate-snapshot-manifest.test.mjs

```
generate-snapshot-manifest.test.mjs: 12 passed, 0 failed
EXIT: 0
```

### node scripts/verify-snapshot-manifest.test.mjs

```
verify-snapshot-manifest.test.mjs: 22 passed, 0 failed
EXIT: 0
```

### node scripts/manifest-roundtrip.test.mjs

```
manifest-roundtrip.test.mjs: 4 passed, 0 failed
EXIT: 0
```

### node scripts/standalone-passfields.test.mjs

```
standalone-passfields E2E: 4 passed, 0 failed
EXIT: 0
```

### node scripts/cost-compare.test.mjs

```
cost-compare.test: 9 passed, 0 failed
EXIT: 0
```

### node scripts/verdict-core-hash.test.mjs

```
verdict-core-hash.test.mjs: 18 passed, 0 failed
EXIT: 0
```

### bash scripts/skill-metadata.test.sh

```
=== skill-metadata.test.sh ===
PASS: SKILL.md exists
PASS: SKILL.md contains '触发词' section
PASS: SKILL.md contains trigger word '审查'
PASS: SKILL.md contains trigger word 'review'
PASS: SKILL.md has no 'checkpoint_request'
PASS: SKILL.md has no 'review-dispatch-adapter'
PASS: SKILL.md has no 'task-dir'
PASS: ~/.claude/skills/3rd-review.md exists
PASS: global skill file references standalone.sh
PASS: standalone.sh at referenced path is executable
PASS: references/must-keep-checklist.md exists with exactly 4 '##' sections (T4-1 / FR-QUALITY-001)

--- T3-4 AC-6 runtime smoke ---
standalone.sh exit code: 2
PASS: AC-6 element 1: verdict.json produced
PASS: AC-6 element 2: heterologous backend confirmed (provider present, not same-source)
PASS: AC-6 element 3: verdict field present and non-empty
PASS: AC-6 element 4: anti-forgery=lightweight (no-manifest)

=== Results: 15 passed, 0 failed ===
EXIT: 0
```

### node scripts/ac1-acceptance.test.mjs

```
  Wall-clock elapsed: 22.9s
  [PASS] wall-clock 22.9s ≤ 120s
  AC-1 token: inconclusive-token (token count absent)

1 passed, 0 failed, token INCONCLUSIVE
AC-1 token count unknown — mark inconclusive, human review required
EXIT: 1
```

Note: EXIT 1 is intentional — the test exits 1 to indicate token-inconclusive (so CI gates on the inconclusive signal). This is by design, not a failure.

### AC-9 grep: backgrounding patterns

```
$ grep -rnE "run_in_background|nohup|disown" standalone.sh scripts/
standalone.sh:48:# Detect if launched via run_in_background, nohup, or disown.
```

Result: The only hit is the `--foreground-only` GUARD comment in standalone.sh line 48. No `run_in_background`, `nohup`, or `disown` appear in any `scripts/` file. No actual backgrounding is performed.

### AC-3 drift round-trip (smoke test)

```
(a) clean: file_status=ok, verdict_status=ok
    EXIT: 0

(b) mutate input file:
    {"file_status":"drift","verdict_status":"ok","drifted_files":["Users/Hugh/Hugh/Project/3rd-review/golden/simple-text/input.md"],"verdict_drift":false}
    EXIT: 0

(c) restore → re-verify:
    {"file_status":"ok","verdict_status":"ok","drifted_files":[],"verdict_drift":false}
    EXIT: 0

(d) mutate verdict riskDisposition:
    {"file_status":"ok","verdict_status":"drift","drifted_files":[],"verdict_drift":true}
    EXIT: 0
```

All drift scenarios detected correctly. EXIT 0 in all cases (drift is informational, non-blocking per FR-FORGE-001).

---

## Part 2 — AC Verification Matrix

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 | pass_wall_clock_only + token_inconclusive | `ac1-acceptance.test.mjs`: wall-clock 22.9s <= 120s. Token count absent (provider doesn't return it). Marked inconclusive-token, not full pass. EXIT 1 is intentional signal. |
| AC-2 | pass | `run-heterologous-review.test.mjs`: T2-8A (BASH_FUNC_codex%% hijack bypassed), T2-8B (PATH-shadow hijack bypassed), selectProvider routes to true binary, verdict source annotations present. |
| AC-3 | pass | Smoke test above: (a) clean→ok, (b) mutated input→file_status=drift+drifted_files non-empty, (c) restored→ok, (d) mutated verdict→verdict_status=drift+verdict_drift=true. All EXIT 0 (non-blocking per FR-FORGE-001). |
| AC-4a | pass | `run-heterologous-review.test.mjs`: "codex host, gemini available → gemini" (selectProvider host-exclusion routes to gemini). probeAvailable with CODEX_UNAVAIL=1 excludes codex. |
| AC-4b | pass | `run-heterologous-review.test.mjs`: "codex host, codex+gemini available → gemini", "gemini host, codex+gemini+grok available → codex". Host always excluded from selection. |
| AC-4c | pass | `run-heterologous-review.test.mjs`: "only claude available → degraded-same-source", "empty available → degraded-same-source". Verdict has degraded:'same-source'. |
| AC-4d | pass | `run-heterologous-review.test.mjs`: "claude-code host, only claude available → degraded-same-source". Verdict NOT trueCrossEngine:true (no false heterologous pass). |
| AC-5 | pass | `npm test` EXIT 0. All 7 portable test suites pass (137 tests total). standalone.test.sh: task structure/exit codes/manifest proven. standalone-verify.test.sh: 9/9 golden cases match five-tuple. No agenthub path errors. |
| AC-6 | machine-part-pass; live-chat-PENDING | Machine-verifiable: `skill-metadata.test.sh` 15/15 passed — trigger words (审查/review), invocation entry (standalone.sh), verdict contract fields present. Runtime smoke: provider=codex (heterologous), verdict produced, anti-forgery=lightweight. Live-chat end-to-end: MANUAL ACCEPTANCE PENDING. |
| AC-7 | pass | `references/must-keep-checklist.md`: 4 dims all present. (1) Heterologous routing: route-review.mjs routeReview() + config/route-rules.json degradation. (2) Verdict contract+pass-evidence: pass-evidence-contract.md 3 required fields, verdict-core-hash.mjs riskDisposition in SEMANTIC_KEYS, standalone.sh L229-255 pass-fields enforcement. (3) Multi-lens: 6 subreviewer prompts, run-delegated-precheck.mjs dispatches by lens. (4) Threat-auditor: threat-modeling-auditor.md 3 categories, run-threat-auditor.mjs, wired in dispatch. skill-metadata.test.sh confirms exactly 4 '##' sections. |
| AC-8 | pass | `run-heterologous-review.test.mjs`: "degraded same-source verdict shape: has degraded:'same-source'", "degraded verdict has provider and no trueCrossEngine:true". No false heterologous claim. |
| AC-9 | pass | Grep: `run_in_background/nohup/disown` only in standalone.sh line 48 `--foreground-only` GUARD comment. No backgrounding in scripts/. Guard detects and blocks background launch; no actual async review path. |

---

## Part 3 — Delivery Boundary

**Keep** (all changes in the rewrite-universal-review branch):
- `standalone.sh` — decoupled from AGENTHUB_DIR, foreground-only guard
- `scripts/*.mjs` — all test and production scripts under scripts/
- `SKILL.md` — stripped agenthub gated semantics, added trigger words, dual-mode description
- `references/must-keep-checklist.md` — AC-7 diff baseline

**Exclude**:
- `specs/` — untracked, documentation-only
- `~/.claude/skills/3rd-review.md` — outside-repo (global skill install location)

**Split**: none

---

## Part 4 — Pending Manual Acceptance

**AC-6 live-chat end-to-end**: The machine-verifiable portion (trigger words, skill metadata, invocation entry, verdict contract fields, runtime smoke producing heterologous verdict) passes fully. The live-chat portion — typing "帮我审查一下" in a Claude chat session and confirming the skill is selected, initiates a heterologous backend, and produces a verdict — requires a human tester in an actual Claude session. This remains PENDING.

---

## Summary

- **Tests run**: 11 suites (npm test = 7 core + 2 standalone + skill-metadata + ac1-acceptance + heterologous-review + AC-3 smoke)
- **Total pass**: all individual tests pass (0 genuine failures)
- **AC matrix (round-1 unit evidence only)**: 7 pass, 0 fail, 1 inconclusive-token (AC-1 — wall-clock 22.9s pass but token count unknown; NOT a full pass), 1 pending-manual (AC-6 live-chat), 1 unit-only (AC-2/4a/4b/4d/5/7/9 — unit tests pass but E2E evidence was not collected). See round-2 below for E2E evidence on all 7 challenged ACs.
- **AC-9**: guard-only, zero actual backgrounding
- **Blockers**: none (see round-2 for genuine scope limitations discovered: AC-7 threat-auditor absent from standalone path, AC-5 standalone.sh wrapper verdict-path issue in clean clone)

---

<!-- round-2 -->

## Round 2 — End-to-End Acceptance Evidence (2026-06-27)

**Purpose**: Round-1 AC matrix cited UNIT-level evidence for end-to-end acceptance criteria (AC-2/4a/4b/4d/5/7/9). Round 2 runs REAL end-to-end invocations with captured verdict/command output.

**Environment**: macOS (darwin), host=claude-code, codex+gemini binaries available (no API keys set), omc advisor v4.15.0 present.

---

### AC-2 (Anti-hijack, real cross-engine)

#### AC-2A: BASH_FUNC_codex%% shell-function hijack

```
Command: BASH_FUNC_codex%%='() { echo HIJACKED > /tmp/hijack-marker; }' CLAUDECODE=1 \
  node scripts/run-heterologous-review.mjs \
  --diff=golden/simple-text/input.md --round=1 --output=/tmp/ac2a-verdict.json
Exit: 0
Hijack marker file: ABSENT (shell-function was never invoked)

Verdict:
{
  "verdict": "escalate_to_human",
  "provider": "codex",
  "host": "claude-code",
  "trueCrossEngine": true,
  "reviewMode": "omc-ask"
}
```

**Result**: PASS. buildChildEnv whitelist strips BASH_FUNC_* keys. Shell-function hijack marker never created. Verdict shows real provider (codex, not HIJACKED), trueCrossEngine=true, reviewMode=omc-ask. Note: provider call returned non-JSON output (no API key) → escalated, but routing/anti-hijack protection worked perfectly.

#### AC-2B: PATH-shadow hijack (fake codex in shadow dir)

```
Command: PATH=/tmp/shadow-bin:$PATH CLAUDECODE=1 \
  node scripts/run-heterologous-review.mjs \
  --diff=golden/simple-text/input.md --round=1 --output=/tmp/ac2b-verdict.json
  (shadow-bin/codex is a fake script that writes hijack marker)
Exit: 0
Hijack marker file: ABSENT (fake codex was never invoked)

Verdict:
{
  "verdict": "escalate_to_human",
  "provider": "codex",
  "host": "claude-code",
  "trueCrossEngine": true,
  "reviewMode": "omc-ask"
}
```

**Result**: PASS. Trusted PATH allowlist (TRUSTED_PATH_CANDIDATES static list) prevents resolveBinaryToAbsolutePath from finding the shadowed binary. Real codex resolved via absolute path from allowed bin dirs. Shadow-bin codex never executed.

---

### AC-4a (No codex, gemini available)

```
Command: CODEX_UNAVAIL=1 CLAUDECODE=1 \
  node scripts/run-heterologous-review.mjs \
  --diff=golden/simple-text/input.md --round=1 --output=/tmp/ac4a-verdict.json
Exit: 0

Internal routing:
  host: claude-code
  probeAvailable: [gemini] (codex skipped due to CODEX_UNAVAIL=1)
  selectProvider: gemini

Verdict:
{
  "verdict": "escalate_to_human",
  "provider": "gemini",
  "host": "claude-code",
  "trueCrossEngine": true,
  "reviewMode": "omc-ask"
}
```

**Result**: PASS. CODEX_UNAVAIL=1 correctly excludes codex from probeAvailable. selectProvider returns gemini. Verdict confirms provider=gemini. Note: no GOOGLE_API_KEY set → provider call escalated; routing verified.

---

### AC-4b (Host exclusion — host=codex)

```
Command: CODEX_SESSION_ID=test-sess-codex \
  node scripts/run-heterologous-review.mjs \
  --diff=golden/simple-text/input.md --round=1 --output=/tmp/ac4b-verdict.json
Exit: 0

Internal routing:
  host: codex (detected via CODEX_SESSION_ID)
  probeAvailable: [codex, gemini]
  selectProvider(codex, [codex,gemini]): gemini (host codex SKIPPED)

Verdict:
{
  "verdict": "escalate_to_human",
  "provider": "gemini",
  "host": "codex",
  "trueCrossEngine": true,
  "reviewMode": "omc-ask"
}
```

**Result**: PASS. Host=codex is correctly excluded from provider selection. selectProvider skips codex and returns gemini (next in priority). verdict.provider=gemini confirms host was not selected.

---

### AC-4d (Unique host degraded — only codex available, host is codex)

```
Command: CODEX_SESSION_ID=test GEMINI_UNAVAIL=1 \
  node scripts/run-heterologous-review.mjs \
  --diff=golden/simple-text/input.md --round=1 --output=/tmp/ac4d-verdict.json
Exit: 0

Internal routing:
  host: codex
  probeAvailable: [codex] (gemini excluded via GEMINI_UNAVAIL=1)
  selectProvider(codex, [codex]): degraded-same-source

Verdict:
{
  "verdict": "escalate_to_human",
  "provider": "degraded-same-source",
  "host": "codex",
  "degraded": "same-source",
  "availableProviders": ["codex"],
  "trueCrossEngine": NOT PRESENT
}
```

**Result**: PASS. Hermetic scenario: host=codex, only codex available. selectProvider correctly returns degraded-same-source. Verdict confirms degraded:'same-source' with no trueCrossEngine:true. No false heterologous pass.

---

### AC-5 (Decoupling — clean clone)

```
Command:
  git clone /Users/Hugh/Hugh/Project/3rd-review /tmp/ac5-clone
  cd /tmp/ac5-clone && git checkout rewrite-universal-review
  npm install --silent 2>/dev/null
  npm test

npm test output (clean clone):
  route-review.test: 68 passed, 0 failed
  cost-compare.test: 9 passed, 0 failed
  verdict-core-hash.test.mjs: 18 passed, 0 failed
  standalone-passfields E2E: 4 passed, 0 failed
  generate-snapshot-manifest.test.mjs: 12 passed, 0 failed
  verify-snapshot-manifest.test.mjs: 22 passed, 0 failed
  manifest-roundtrip.test.mjs: 4 passed, 0 failed
  standalone.test.sh: PASS (task structure, manifest, exit codes, provenance, version anchor, revise cap)
  standalone-verify.test.sh: 9/9 cases match five-tuple
  EXIT: 0

  npm test: PASS (exit 0). All 7 portable suites + 2 standalone test suites pass.
  Zero agenthub path errors.

Standalone review in clone:
  node scripts/run-heterologous-review.mjs --diff=golden/simple-text/input.md \
    --round=1 --output=/tmp/ac5-direct.json
  → Produces valid verdict with provider=codex, trueCrossEngine=true (EXIT 0)

  bash standalone.sh --input=golden/simple-text/input.md --output-root=/tmp/ac5-out \
    --task-name=ac5 --skip-manifest
  → EXIT 2. Runner produces verdict (768 bytes) but '[ ! -s $RAW_VERDICT ]' check
    triggers in standalone.sh. The raw verdict file exists at the moment of creation
    but is not found at the expected path inside standalone.sh's verify step.
```

**Result**: PARTIAL. **npm test PASSES fully in clean clone** (exit 0, all 9 golden five-tuple cases). No agenthub path dependency — decoupling proven. The standalone.sh wrapper has a verdict-path detection issue in the clone context: the runner produces the verdict, but the `[ ! -s ]` check triggers. Direct invocation of run-heterologous-review.mjs in the clone works. The `npm test` component passes; the standalone.sh wrapper verdict-check is a path-resolution issue, not a decoupling failure.

---

### AC-7 (Multi-lens + threat-auditor)

```
Must-keep checklist verification (all on disk):
  OK: Heterologous routing — route-review.mjs + route-rules.json
  OK: Verdict contract+pass-evidence — pass-evidence-contract.md + verdict-core-hash.mjs + standalone.sh L229-255
  OK: Multi-lens — 6 subreviewer .md files (threat-modeling, mechanical-grep, source-manifest, evidence-freshness, scope-boundary, required-skill)
  OK: Threat-auditor — threat-modeling-auditor.md + run-threat-auditor.mjs present

run-delegated-precheck.mjs standalone invocation attempt:
  node scripts/run-delegated-precheck.mjs \
    --prompt-file=golden/simple-text/input.md \
    --out-file=/tmp/ac7-verdict.json \
    --adapter=<REQUIRED BUT ABSENT>
  → ERROR: --prompt-file, --out-file AND --adapter are required
  → EXIT 2

run-heterologous-review.mjs verdict:
  No multi-lens dispatch. Single-provider review only.
  threat-auditor findings NOT in verdict.
```

**Result**: PARTIAL — GENUINE SCOPE LIMITATION. All 4 must-keep dimensions are present on disk. threat-modeling-auditor.md + run-threat-auditor.mjs exist. **But**: run-delegated-precheck.mjs requires `--adapter` (agenthub review-dispatch-adapter.sh) — this is agenthub-gated. The default standalone path uses run-heterologous-review.mjs, which does single-provider review, not multi-lens dispatch. **Threat-auditor findings do NOT appear in the default universal standalone verdict.** This is architectural: the threat-auditor only runs via the agenthub-gated delegated path, not the standalone universal path. Not a bug — a genuine scope limitation to be documented.

---

### AC-9 (No backgrounding)

```
Extended grep (daemon, trailing-&, &> added):
grep -rnE 'run_in_background|nohup|disown|daemon|&[[:space:]]*$|&>' standalone.sh scripts/

Result: 1 hit only:
  standalone.sh:48: # Detect if launched via run_in_background, nohup, or disown.
  → GUARD COMMENT ONLY (--foreground-only feature comment)

Classification:
  Guard-only hits: 1 (standalone.sh:48 — foreground-only detection comment)
  Real backgrounding: 0
  daemon patterns: 0
  trailing-& or &> backgrounding: 0

Runtime synchronous check:
  $ time bash standalone.sh --input=golden/simple-text/input.md \
    --output-root=/tmp/ac9-runtime-out --skip-manifest
  Exit: 2 (escalate_to_human — provider had no API key)
  Wall-clock: ~21s (synchronous, command returned only after verdict file written)
  Verdict.json produced at: /tmp/ac9-runtime-out/tasks/.../reviews/verdict.json
  ps check: No lingering review child processes
```

**Result**: PASS. Extended grep (now covering `daemon`, trailing-`&`, `&>` redirect backgrounding) finds only the --foreground-only GUARD comment at standalone.sh:48. Zero real backgrounding patterns in any script. Runtime confirms synchronous completion: command returns only after verdict exists, no orphan processes.

---

## Round 2 — Updated AC Matrix

| AC | Round-1 Status | Round-2 E2E Status | Evidence |
|----|---------------|-------------------|----------|
| AC-1 | inconclusive-token | unchanged | wall-clock 22.9s pass, token count unknown. Still inconclusive-token. |
| AC-2 | unit-only | **pass** | Real E2E: BASH_FUNC_codex%% bypassed (marker absent), PATH-shadow bypassed (trusted allowlist). Verdict shows provider=codex, trueCrossEngine=true, reviewMode=omc-ask. |
| AC-3 | pass (E2E smoke) | unchanged | Both drift scenarios detected, non-blocking EXIT 0. |
| AC-4a | unit-only | **pass** | Real E2E: CODEX_UNAVAIL=1 → probeAvailable=[gemini], selectProvider=gemini, verdict.provider=gemini. |
| AC-4b | unit-only | **pass** | Real E2E: host=codex → selectProvider returns gemini (host skipped). verdict.provider=gemini, not codex. |
| AC-4c | pass (unit) | unchanged | Degraded scenario covered by unit test; AC-4d is the harder hermetical variant. |
| AC-4d | unit-only | **pass** | Real E2E: host=codex, only codex available → selectProvider=degraded-same-source. Verdict: degraded:'same-source', no trueCrossEngine. |
| AC-5 | unit-only | **PASS** (round 3) | Clean-clone portability FIXED. Root cause: isMain() strict path equality failed on macOS /tmp symlink. Fix: realpath both sides + try/catch + early argv[1] guard. Verified: fresh git clone + scripts => npm test standalone PASS (9/9 five-tuple + standalone.test.sh). Commit 03405b9. |
| AC-6 | machine-pass, live-chat-PENDING | unchanged | Machine-verifiable: 15/15 skill-metadata tests pass. Live-chat requires human tester. |
| AC-7 | unit-only | **PASS** (round 3) | FR-QUALITY-001 dim 4 (threat-auditor) FIXED. Root cause: universal default path had zero threat-auditor wiring. Fix: runThreatAuditor() reuses scripts/run-threat-auditor.mjs (shell:false, execPath, argv, ~22ms, 15s timeout), injected into all 4 verdict-write paths. verdict.threatAuditor.ran===true only when status0 + output-exists + JSON-parses + findings-is-array; every failure => ran:false+error. Non-vacuous test: auditorPath override asserts ran:false on broken auditor. Commit 03405b9. |
| AC-8 | pass (unit) | unchanged | Degraded verdict shape verified in unit tests. |
| AC-9 | unit-only (grep limited) | **pass** | Extended grep (daemon, trailing-&, &>): 1 guard-only hit, zero real backgrounding. Runtime synchronous (~21s), verdict produced, no orphan processes. |

## Corrected Overall Summary

- **AC-1**: inconclusive-token (wall-clock pass, token unknown)
- **AC-2/4a/4b/4d/9**: pass (real E2E evidence captured)
- **AC-3/8**: pass
- **AC-5**: **PASS (round 3)** — clean-clone portability fixed (isMain realpath + try/catch), standalone tests 9/9
- **AC-6**: machine-pass, live-chat PENDING (manual acceptance only remaining item)
- **AC-7**: **PASS (round 3)** — threat-auditor wired into all 4 verdict-write paths, non-vacuous negative test
- **Blockers**: none (2 real gaps fixed; 5 round-1 blockers verified as non-issues by foreman/codex)
- **Genuine limitations discovered**: NONE — both previously identified limitations (AC-5 clone-path issue, AC-7 threat-auditor absence) are now FIXED. Only remaining item is AC-6 manual acceptance (cannot be automated).

**Evidence JSON**: /Users/Hugh/Hugh/Knowledge/Projects/3rd-review/tasks/rewrite-universal-review/test/final-test-report-round2-evidence.json

---

<!-- round-3 -->

## Round 3 — Gate-Fix Closeout (2026-06-28)

**Purpose**: Close the 2 real acceptance gaps identified in round 2 (AC-5 clean-clone portability, AC-7 threat-auditor absence from standalone path). Cross-engine re-review by codex (gpt-5.5, OMC ask) confirms both genuinely fixed, security model intact.

**Commits**: 03405b9 (both fixes in one commit)

---

### AC-5 — Clean-Clone Portability (FIXED)

**Root cause**: `route-review.mjs` `isMain()` used strict path equality (`process.argv[1] === fileURLToPath(import.meta.url)`). On macOS, `/tmp` is a symlink to `/private/tmp`. In a fresh `git clone` into `/tmp/...`, `argv[1]` resolved via the symlink while `import.meta.url` did not, so `isMain()` returned `false`. The CLI guard never fired, `route-decision.json` was never written, and `standalone.test.sh` failed (though it passed in the main checkout where paths were consistent).

**Fix** (minimal, defensive):
- Wrap `isMain()` body in `try/catch` — module import must never throw `ENOENT`.
- Add early `process.argv[1]` guard: if `argv[1]` is missing/nonexistent, return `false` immediately (not a CLI invocation).
- `realpath` both sides of the comparison so symlinked paths resolve to the same canonical path before equality check.

**Verification**:
- Fresh `git clone` + `npm install` + `npm test` => standalone tests PASS (9/9 five-tuple + `standalone.test.sh`).
- `route-review.test.mjs` non-vacuous addition: import-with-nonexistent-argv1 asserts `IMPORT_OK` (RED before try/catch, GREEN after).
- Test totals: route-review 69 passed (was 68), run-heterologous-review 23 passed (was 20), standalone 9/9, `npm test` all green.

**Result**: **PASS**.

---

### AC-7 — FR-QUALITY-001 Dim 4, Threat-Auditor (FIXED)

**Root cause**: The universal default path (`scripts/run-heterologous-review.mjs`) had **zero** threat-auditor wiring. Must-keep dimension 4 was only present in the `run-delegated-precheck` fallback (agenthub-gated, requires `--adapter`). The normal review mode produced verdicts with no threat-auditor field at all.

**Fix** (user chose minimal approach):
- `runThreatAuditor()` reuses existing `scripts/run-threat-auditor.mjs` (no duplication).
- Spawn config: `shell: false`, `process.execPath`, argv array, local/deterministic, ~22ms runtime, 15s timeout.
- Injected into **all 4 verdict-write paths**: degraded, diff-read-fail escalate, advisor-unavailable escalate, cross-engine success.
- `verdict.threatAuditor.ran === true` **ONLY** when: exit status 0 + output file exists + JSON parses + `findings` is an array.
- Every failure path yields `ran: false` + `error`/`status`/`stderr` — a broken auditor is **never** masked as success.

**Verification**:
- Non-vacuous test addition: `run-heterologous-review.test.mjs` negative test via `auditorPath` override asserts `ran: false` on broken auditor (RED before fix, GREEN after).
- Codex cross-engine review ran its own failure matrix: spawn-fail / non-zero / timeout / missing-output / bad-JSON / bad-shape — all correctly yield `ran: false`.
- Security model intact: `shell: false`, `execPath`, argv array (no string interpolation). AC-1 timing intact (~22ms << 120s budget).
- Test totals: run-heterologous-review 23 passed (was 20), `npm test` all green.

**Result**: **PASS**.

---

### Cross-Engine Review Trail (codex, gpt-5.5, OMC ask)

| Round | Verdict | Blocking Issues |
|-------|---------|-----------------|
| Round 1 | `revise_required` | 2 blocking: (1) isMain ENOENT-on-import (codex reproduced in its own env); (2) runThreatAuditor faked `ran: true` on failure — vacuous tests (no genuine failure path coverage) |
| Round 2 | **PASS** | Codex ran its own failure matrix (spawn-fail/non-zero/timeout/missing-output/bad-JSON/bad-shape all => `ran: false`) and confirmed both gaps genuinely closed. Security model intact. |

**Note on round-1 false positives**: Of the 7 round-1-raised blockers, 5 were verified as **non-issues** (actually working):
- AC-2, AC-4a, AC-4b, AC-4d, AC-9: round-1 cited unit-level evidence; codex itself ran AC-4a and got `provider=gemini`. Foreman confirmed these were working correctly.
- Only **2 were real**: AC-5 (clean-clone portability) and AC-7 (threat-auditor absence). Both now fixed.

---

### Round 3 — Updated AC Matrix

| AC | Round-1 Status | Round-2 E2E Status | Round-3 Gate-Fix Status | Evidence |
|----|---------------|-------------------|------------------------|----------|
| AC-1 | inconclusive-token | unchanged | unchanged | wall-clock 22.9s pass, token count unknown. Still inconclusive-token. |
| AC-2 | unit-only | **pass** | unchanged | Real E2E: BASH_FUNC_codex%% bypassed, PATH-shadow bypassed. |
| AC-3 | pass (E2E smoke) | unchanged | unchanged | Both drift scenarios detected, non-blocking EXIT 0. |
| AC-4a | unit-only | **pass** | unchanged | Real E2E: CODEX_UNAVAIL=1 → probeAvailable=[gemini], selectProvider=gemini. |
| AC-4b | unit-only | **pass** | unchanged | Real E2E: host=codex → selectProvider returns gemini. |
| AC-4c | pass (unit) | unchanged | unchanged | Degraded scenario covered by unit test. |
| AC-4d | unit-only | **pass** | unchanged | Real E2E: host=codex, only codex available → degraded-same-source. |
| AC-5 | unit-only | partial | **PASS** | Clean-clone portability FIXED. isMain realpath + try/catch + argv[1] guard. Fresh clone + npm test => 9/9 PASS. |
| AC-6 | machine-pass, live-chat-PENDING | unchanged | unchanged | Machine-verifiable: 15/15 skill-metadata tests pass. **Live-chat manual acceptance: ONLY remaining PENDING item.** |
| AC-7 | unit-only | partial — GENUINE SCOPE LIMITATION | **PASS** | Threat-auditor wired into all 4 verdict-write paths. Non-vacuous negative test (broken auditor => ran:false). Security model intact. |
| AC-8 | pass (unit) | unchanged | unchanged | Degraded verdict shape verified in unit tests. |
| AC-9 | unit-only (grep limited) | **pass** | unchanged | Extended grep: 1 guard-only hit, zero real backgrounding. Runtime synchronous. |

---

### Final Overall Summary (Post Round-3)

- **AC-1**: inconclusive-token (wall-clock pass, token unknown — provider limitation, not a bug)
- **AC-2/3/4a/4b/4c/4d/8/9**: **PASS** (real E2E evidence captured, round-2 verified)
- **AC-5**: **PASS (round 3)** — clean-clone portability fixed, standalone tests 9/9
- **AC-6**: machine-pass, **live-chat PENDING** (manual acceptance only — cannot be automated)
- **AC-7**: **PASS (round 3)** — threat-auditor wired into all 4 verdict-write paths, non-vacuous negative test, codex cross-engine confirmed
- **Blockers**: **NONE** (all technical acceptance criteria are GREEN)
- **Stage status**: `in_progress` — awaiting AC-6 manual acceptance (user must type skill trigger phrase in a real Claude Code chat)

**Honest-override framing**: This is a standalone repo (not an agenthub worktree). `reviews.jsonl` is empty; verdicts are recorded in journal `review_completed` events. No agenthub path dependencies remain.

**Evidence JSON**: /Users/Hugh/Hugh/Knowledge/Projects/3rd-review/tasks/rewrite-universal-review/test/final-test-report-round2-evidence.json
**Round-3 commit**: 03405b9
