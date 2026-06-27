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
  'vibecoding/code-reviewer.md',
  'vibecoding/code-reviewer-contract.md',
  'vibecoding/design-reviewer.md',
  'vibecoding/design-reviewer-contract.md',
  'vibecoding/plan-reviewer.md',
  'vibecoding/plan-reviewer-contract.md',
  'vibecoding/test-acceptance-reviewer.md',
  'vibecoding/test-acceptance-reviewer-contract.md',
  'vibecoding/intake-direction-reviewer.md',
  'vibecoding/intake-detail-reviewer.md',
  'vibecoding/intake-reviewer-contract.md',
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
