// Phase 1 migration acceptance test: the 12 review files must live at the new
// two-layer location under skills/3rd-review/verifiers/ (base-verifier + vibecoding/),
// and the old locations must be gone. This test fails RED before the migration
// (new paths absent) and passes GREEN after.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const VERIFIERS = resolve(__dirname); // skills/3rd-review/verifiers
const AGENTHUB = resolve(__dirname, '../../..'); // packages/core/agenthub

const NEW_FILES = [
  'base-verifier.md',
  'vibecoding/build-code-reviewer.md',
  'vibecoding/build-code-reviewer-contract.md',
  'vibecoding/build-spec-reviewer.md',
  'vibecoding/build-spec-reviewer-contract.md',
  'vibecoding/build-plan-reviewer.md',
  'vibecoding/build-plan-reviewer-contract.md',
  'vibecoding/verify-code-reviewer.md',
  'vibecoding/verify-code-reviewer-contract.md',
  'vibecoding/make-decision-direction-reviewer.md',
  'vibecoding/make-decision-detail-reviewer.md',
  'vibecoding/make-decision-reviewer-contract.md',
];

describe('Phase 1: review files migrated to two-layer verifiers/ structure', () => {
  it('all 12 review files exist at the new two-layer location', () => {
    const missing = NEW_FILES.filter((f) => !existsSync(resolve(VERIFIERS, f)));
    expect(missing).toEqual([]);
  });

  it('old locations are removed', () => {
    expect(existsSync(resolve(AGENTHUB, 'prompts/base-verifier.md'))).toBe(false);
    expect(existsSync(resolve(AGENTHUB, 'workflows/vibecoding/verifiers/code-reviewer.md'))).toBe(false);
  });
});
