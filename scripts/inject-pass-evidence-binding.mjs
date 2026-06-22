#!/usr/bin/env node
// FR-PERSIST-001: extract the pass-evidence-binding requirement (the three fields
// reviewSnapshot / riskDisposition / worktreeInventory, plus the verdict JSON
// output template) from SKILL.md and print it to stdout so the adapter's enrich
// path can append it to the reviewer prompt.
//
// SINGLE SOURCE: SKILL.md is the template source (tasks.md L137). This script
// NEVER hardcodes the field text — it extracts by heading marker so SKILL.md
// stays the only hand-maintained copy. Extraction is by MARKER, never line
// number: Phase 7 slims SKILL.md and shifts every line; a line-range extractor
// would be the "模板漂移" bug pre-armed.
//
// FAIL LOUD: if the section cannot be found, exit non-zero with a message. Never
// print nothing — a silently-empty injection recreates the orphan FR-PERSIST-001
// exists to eliminate (field "required" but no producer instruction).
//
// Usage: node inject-pass-evidence-binding.mjs --skill-md=<path>

import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

const args = parseArgs(process.argv);
const skillMd = args['skill-md'];
if (!skillMd) {
  process.stderr.write('ERROR: --skill-md=<path> is required\n');
  process.exit(2);
}

let text;
try {
  text = readFileSync(skillMd, 'utf8');
} catch (e) {
  process.stderr.write(`ERROR: cannot read SKILL.md at ${skillMd}: ${e.message}\n`);
  process.exit(2);
}

const lines = text.split('\n');

// Start marker: the pass-evidence-binding requirement line.
const startIdx = lines.findIndex((l) => l.startsWith('**Pass evidence binding**:'));
// End marker: the verdict JSON output template line (begins with the reviewRequestId key).
const templateIdx = lines.findIndex((l) => l.trimStart().startsWith('{"reviewRequestId"'));

if (startIdx === -1 || templateIdx === -1 || templateIdx < startIdx) {
  process.stderr.write(
    'ERROR: pass-evidence-binding section not found in SKILL.md ' +
      '(expected "**Pass evidence binding**:" marker followed by the verdict JSON template). ' +
      'SKILL.md is the template source — if it was renamed/moved, fix the marker here.\n',
  );
  process.exit(3);
}

// Extract the requirement line + the "Output format" intro + the JSON template.
// We pull the binding line, then the output-format intro line and the template,
// skipping the intervening full-review/delegated-trust prose (those are separate
// rules carried by the hand-spliced DISPATCH OVERRIDE, not pass-evidence fields).
const bindingLine = lines[startIdx];
const outputFormatIdx = lines.findIndex(
  (l, i) => i < templateIdx && l.startsWith('Output format'),
);
const outputFormatLine = outputFormatIdx !== -1 ? lines[outputFormatIdx] : 'Output format (English-only JSON):';
const templateLine = lines[templateIdx];

const section = [
  '## Pass Evidence Binding (required for every pass — injected by adapter from SKILL.md)',
  '',
  bindingLine,
  '',
  outputFormatLine,
  templateLine,
  '',
].join('\n');

// Defense in depth: the assembled section MUST mention all three fields, else the
// extraction silently lost content. Fail loud rather than inject a partial.
for (const field of ['reviewSnapshot', 'riskDisposition', 'worktreeInventory']) {
  if (!section.includes(field)) {
    process.stderr.write(
      `ERROR: extracted section is missing required field name "${field}"; ` +
        'SKILL.md template drifted — fix the source.\n',
    );
    process.exit(4);
  }
}

process.stdout.write(section);
process.stdout.write('\n');
