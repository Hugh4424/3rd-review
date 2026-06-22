#!/usr/bin/env node
// verdict-core-hash.mjs — Compute sha256(canonical JSON) of the review semantic record
//
// Usage:
//   node verdict-core-hash.mjs --result-file=<path>
//
// Hash includes: reviewRequestId, round, checkpoint, reviewMode, provider,
// verdict, summary, precheckDecisionSource, routeLevel, and
// findings[].severity/issue/recommendation.
// Excludes (adapter-meta, non-semantic): _execNonce, _runtimeConfig,
// subreviewerRuntimeReports, delegatedReviewBundle, worktreeInventory, riskDisposition.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Top-level keys that form the review semantic record. */
const SEMANTIC_KEYS = [
  "reviewRequestId",
  "round",
  "checkpoint",
  "reviewMode",
  "provider",
  "verdict",
  "summary",
  // DEG R2 fix: the adapter-authoritative precheck decision source and route level
  // are tamper-bound — they gate the lightweight-review exemption in review-persist.sh,
  // so they MUST be inside the hashed semantic record. Without this, a manual
  // `--delegated-precheck=off` (source=explicit) could be relabeled route-driven
  // (source=route) to unlock the exemption with no hash change.
  "precheckDecisionSource",
  "routeLevel",
];

/** Keys inside each finding entry that contribute to the hash.
 *  Includes all judgment-bearing fields: severity, issue, recommendation,
 *  file, line, and impact (matching verifier-report.schema.json).
 *  Excludes only runtime/provenance metadata that is not part of the review judgment. */
const FINDING_KEYS = ["severity", "issue", "recommendation", "file", "line", "impact"];

function parseArgs() {
  const args = process.argv.slice(2);
  let resultFile = "";
  for (const arg of args) {
    if (arg.startsWith("--result-file=")) {
      resultFile = arg.slice("--result-file=".length);
    }
  }
  return { resultFile };
}

/**
 * Build canonical JSON string: sorted keys at every level, no extra whitespace.
 */
function canonicalStringify(obj) {
  if (obj === null || obj === undefined) return "null";
  const type = typeof obj;
  if (type !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * Extract the semantic review record from a full verdict result.
 * Only SEMANTIC_KEYS + findings[FINDING_KEYS] are kept.
 */
function buildSemanticObject(data) {
  const semantic = {};
  for (const key of SEMANTIC_KEYS) {
    if (Object.hasOwn(data, key)) {
      semantic[key] = data[key];
    }
  }
  if (Array.isArray(data.findings)) {
    semantic.findings = data.findings.map((f) => {
      const filtered = {};
      for (const fk of FINDING_KEYS) {
        if (Object.hasOwn(f, fk)) {
          filtered[fk] = f[fk];
        }
      }
      return filtered;
    });
  }
  return semantic;
}

function main() {
  const { resultFile } = parseArgs();
  if (!resultFile) {
    console.error("usage: verdict-core-hash.mjs --result-file=<path>");
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(resultFile, "utf-8"));
  } catch (err) {
    console.error(
      `error reading result file: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  const semantic = buildSemanticObject(report);
  const canonical = canonicalStringify(semantic);
  const hash = createHash("sha256").update(canonical, "utf-8").digest("hex");

  console.log(hash);
}

main();
