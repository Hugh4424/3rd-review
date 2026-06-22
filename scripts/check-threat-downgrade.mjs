#!/usr/bin/env node
/**
 * check-threat-downgrade.mjs
 *
 * CLI: node check-threat-downgrade.mjs --fixture=<path> --constructor=<id> --reviewer=<id> [--repo-root=<path>]
 *
 * Mechanically verifies the three Downgrade Protocol constraints defined in
 * threat-modeling-auditor.md (FR-THREAT-007):
 *
 *   1. Fixture path resolves to a real path under <repoRoot>/design/evidence/
 *      (anchored, not substring — a path like /tmp/not-real-design/evidence/x.json fails)
 *   2. Fixture JSON contains a `confirmedBy` field that equals --reviewer, and a
 *      `category` field that is one of the three valid adversarial categories.
 *      (Proxy for an independent reviewer having examined and signed the fixture.)
 *   3. constructor identity != reviewer identity (anti self-construct-self-verify),
 *      AND fixture's `confirmedBy` != constructor (the confirmer is not the constructor).
 *
 * Exit 0:  all three constraints satisfied (compliant)
 * Exit 1:  one or more constraints violated
 *
 * Repo root resolution (in order):
 *   1. --repo-root=<path> CLI argument
 *   2. Walk up from this script's directory until a dir containing package.json is found
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_CATEGORIES = new Set(["forgery-bypass", "proof-independence", "schema-drift"]);

function argValue(name) {
  const prefix = `--${name}=`;
  const args = process.argv.slice(2);
  const eq = args.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] || "" : "";
}

/**
 * Walk up from startDir until a directory containing .git is found (repo root).
 * Falls back to the first directory containing package.json if .git is absent.
 */
function findRepoRoot(startDir) {
  let dir = startDir;
  let firstPackageJson = null;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir; // .git is the authoritative repo-root marker
    }
    if (firstPackageJson === null && fs.existsSync(path.join(dir, "package.json"))) {
      firstPackageJson = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return firstPackageJson || startDir;
}

function main() {
  const fixturePath = argValue("fixture");
  const constructor = argValue("constructor");
  const reviewer = argValue("reviewer");
  const repoRootArg = argValue("repo-root");

  // Resolve repo root: explicit arg → walk up from this file's dir.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = repoRootArg
    ? path.resolve(repoRootArg)
    : findRepoRoot(scriptDir);

  const designEvidenceDir = path.join(repoRoot, "design", "evidence");

  const violations = [];

  // ------------------------------------------------------------------
  // Constraint 1: fixture path must resolve under <repoRoot>/design/evidence/
  // Use fs.realpathSync to resolve symlinks; then check path.relative()
  // does not start with ".." and is not absolute.
  // ------------------------------------------------------------------
  let fixtureReal = null;
  try {
    fixtureReal = fs.realpathSync(path.resolve(fixturePath));
  } catch {
    violations.push(
      `Constraint 1 violated: fixture path "${fixturePath}" cannot be resolved (does not exist or is not accessible).`
    );
  }

  if (fixtureReal !== null) {
    let evidenceReal;
    try {
      evidenceReal = fs.realpathSync(designEvidenceDir);
    } catch {
      // design/evidence dir itself may not exist — treat as violation.
      evidenceReal = designEvidenceDir;
    }
    const rel = path.relative(evidenceReal, fixtureReal);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      violations.push(
        `Constraint 1 violated: fixture real path "${fixtureReal}" is not under ` +
        `"${evidenceReal}" (design/evidence/ anchor check failed — substring tricks are rejected).`
      );
    }
  }

  // ------------------------------------------------------------------
  // Constraint 2: fixture JSON must contain:
  //   - `confirmedBy` field equal to --reviewer (independent reviewer signed it)
  //   - `category` field that is a valid adversarial category
  // ------------------------------------------------------------------
  let fixtureJson = null;
  if (fixtureReal !== null) {
    try {
      const raw = fs.readFileSync(fixtureReal, "utf8");
      if (!raw.trim()) {
        violations.push(`Constraint 2 violated: fixture file "${fixturePath}" is empty.`);
      } else {
        fixtureJson = JSON.parse(raw);
      }
    } catch (err) {
      violations.push(
        `Constraint 2 violated: fixture file "${fixturePath}" is not readable or not valid JSON: ${err.message}`
      );
    }
  }

  if (fixtureJson !== null) {
    const confirmedBy = fixtureJson.confirmedBy;
    const category = fixtureJson.category;

    if (!confirmedBy) {
      violations.push(
        `Constraint 2 violated: fixture JSON has no "confirmedBy" field. ` +
        `An independent reviewer must sign the fixture with their identity.`
      );
    } else if (confirmedBy !== reviewer) {
      violations.push(
        `Constraint 2 violated: fixture "confirmedBy" is "${confirmedBy}" but --reviewer is "${reviewer}". ` +
        `The independent confirmation must come from the reviewer running this check.`
      );
    }

    if (!category) {
      violations.push(
        `Constraint 2 violated: fixture JSON has no "category" field. ` +
        `Must be one of: ${[...VALID_CATEGORIES].join(", ")}.`
      );
    } else if (!VALID_CATEGORIES.has(category)) {
      violations.push(
        `Constraint 2 violated: fixture "category" is "${category}", which is not a valid adversarial category. ` +
        `Must be one of: ${[...VALID_CATEGORIES].join(", ")}.`
      );
    }
  }

  // ------------------------------------------------------------------
  // Constraint 3: constructor != reviewer (anti self-construct-self-verify),
  //   and confirmedBy != constructor (confirmer is not the constructor).
  // ------------------------------------------------------------------
  if (!constructor) {
    violations.push("Constraint 3 violated: --constructor identity is required.");
  }
  if (!reviewer) {
    violations.push("Constraint 3 violated: --reviewer identity is required.");
  }
  if (constructor && reviewer && constructor === reviewer) {
    violations.push(
      `Constraint 3 violated: constructor identity "${constructor}" equals reviewer identity "${reviewer}". ` +
      `Same-agent self-construct-self-verify is forbidden.`
    );
  }
  // Also check fixture confirmedBy != constructor (belt-and-suspenders).
  if (fixtureJson && fixtureJson.confirmedBy && constructor && fixtureJson.confirmedBy === constructor) {
    violations.push(
      `Constraint 3 violated: fixture "confirmedBy" is "${fixtureJson.confirmedBy}" which equals --constructor. ` +
      `The independent confirmer must not be the constructor of the fixture.`
    );
  }

  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`FAIL: ${v}\n`);
    }
    process.exit(1);
  }

  process.stdout.write("OK: all three Downgrade Protocol constraints satisfied.\n");
  process.exit(0);
}

main();
