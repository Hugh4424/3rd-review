#!/usr/bin/env node
// finding-replay-diff.mjs — Phase 4 (ACPT) quality-acceptance replay-diff tool.
//
// Compares the BLOCKING finding sets of a review checkpoint BEFORE vs AFTER a change
// to prove "the change did not lower review quality" (no blocking finding lost).
// It reads FULL review conclusion records (reviews/<checkpoint>/round-N.json), NOT
// the reviews.jsonl summary counts, so identity is by content, not by a tally.
//
// Identity key for a blocking finding (FR-ACPT-002):
//   severity + normalizedFile + line + normalizedIssue
//
// Quality judgment (核心): PASS iff every BEFORE blocking fingerprint is still present
// AFTER. Lose one → quality dropped → FAIL ("缺一即判质量下降").
//
// Sample-usability guard (FR-ACPT-001): a round is only a usable comparison sample if
// it is a real revise round (verdict === "revise_required") AND has ≥1 blocking finding.
// Zero-to-zero proves nothing.
//
// Pure functions only; a small optional CLI runs when invoked directly.

import { readFileSync } from 'node:fs';

// Printable join delimiter for fingerprint keys. NOTE: deliberately a printable pipe —
// no raw NUL / control byte is written anywhere in this source.
const KEY_SEP = '|';

// --- Deterministic normalizations -------------------------------------------------

// normalizedFile: trim, strip leading "./", collapse path separators to "/", lowercase.
export function normalizeFile(file) {
  let s = String(file == null ? '' : file).trim();
  s = s.replace(/^\.\//, '');
  s = s.replace(/[\\/]+/g, '/');
  return s.toLowerCase();
}

// normalizedIssue: trim, collapse all whitespace runs to a single space, lowercase.
export function normalizeIssue(issue) {
  return String(issue == null ? '' : issue)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// --- Identity key -----------------------------------------------------------------

// fingerprintBlocking: severity + normalizedFile + line + normalizedIssue.
export function fingerprintBlocking(finding) {
  const severity = String(finding && finding.severity != null ? finding.severity : '');
  const file = normalizeFile(finding && finding.file);
  const line = String(finding && finding.line != null ? finding.line : '');
  const issue = normalizeIssue(finding && finding.issue);
  return [severity, file, line, issue].join(KEY_SEP);
}

// --- Round helpers ----------------------------------------------------------------

// isReviseRound: EXACT literal match. NOT a loose "revise" substring — that would
// zero-match the real "revise_required" data and false-green.
export function isReviseRound(round) {
  return !!round && round.verdict === 'revise_required';
}

function blockingFindings(round) {
  const findings = (round && Array.isArray(round.findings)) ? round.findings : [];
  return findings.filter((f) => f && f.severity === 'blocking');
}

// isUsableSample: a real revise round with at least one blocking finding.
export function isUsableSample(round) {
  return isReviseRound(round) && blockingFindings(round).length > 0;
}

// blockingFingerprintSet: dedup set of blocking fingerprints in a round.
function blockingFingerprintSet(round) {
  return new Set(blockingFindings(round).map(fingerprintBlocking));
}

// --- Diff -------------------------------------------------------------------------

// diffBlockingSets: blocking fingerprints present in BEFORE but missing in AFTER.
export function diffBlockingSets(beforeRound, afterRound) {
  const before = blockingFingerprintSet(beforeRound);
  const after = blockingFingerprintSet(afterRound);
  const missing = [];
  for (const fp of before) {
    if (!after.has(fp)) missing.push(fp);
  }
  return missing;
}

// replayDiff: union BEFORE blocking fingerprints across all before-rounds, likewise
// AFTER, and report any before-blocking missing after. PASS iff none missing.
export function replayDiff(beforeRounds, afterRounds) {
  const beforeList = Array.isArray(beforeRounds) ? beforeRounds : [beforeRounds];
  const afterList = Array.isArray(afterRounds) ? afterRounds : [afterRounds];

  const before = new Set();
  for (const r of beforeList) for (const fp of blockingFingerprintSet(r)) before.add(fp);
  const after = new Set();
  for (const r of afterList) for (const fp of blockingFingerprintSet(r)) after.add(fp);

  // FR-ACPT-001: the before side must contain at least one USABLE sample — a
  // revise_required round with >=1 blocking finding. With zero blocking to compare,
  // the gate cannot prove "no quality drop" (zero-to-zero is identity), so it must
  // REJECT (FAIL), never report a vacuous PASS. The isUsableSample guard is enforced
  // here on the actual judgment path (not merely defined), so empty / pass / zero-blocking
  // before-sides fail closed.
  const usableBefore = beforeList.some((r) => isUsableSample(r));
  if (!usableBefore) {
    return {
      judgment: 'FAIL',
      reason: 'no usable before-sample: need a revise_required round with >=1 blocking finding to compare (FR-ACPT-001)',
      missing: [],
      beforeCount: before.size,
      afterCount: after.size,
    };
  }

  const missing = [];
  for (const fp of before) {
    if (!after.has(fp)) missing.push(fp);
  }
  return {
    judgment: missing.length === 0 ? 'PASS' : 'FAIL',
    missing,
    beforeCount: before.size,
    afterCount: after.size,
  };
}

// --- Optional CLI -----------------------------------------------------------------

function readRound(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isMain() {
  return process.argv[1] && process.argv[1].endsWith('finding-replay-diff.mjs');
}

if (isMain()) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)=(.*)$/);
      return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
    }),
  );
  const beforePath = args.before;
  const afterPath = args.after;
  if (!beforePath || !afterPath) {
    console.error('usage: finding-replay-diff.mjs --before=<round-N.json> --after=<round-N.json>');
    process.exit(2);
  }
  const beforeRound = readRound(beforePath);
  const afterRound = readRound(afterPath);
  const result = replayDiff([beforeRound], [afterRound]);
  console.log(JSON.stringify(result, null, 2));
  if (result.judgment === 'FAIL') {
    console.error('quality dropped: blocking findings lost after change:');
    for (const fp of result.missing) console.error(`  - ${fp}`);
  }
  process.exit(result.judgment === 'FAIL' ? 1 : 0);
}
