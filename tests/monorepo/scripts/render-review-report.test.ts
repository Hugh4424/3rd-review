// render-review-report.test.ts — Phase 3 RPT (report slimming) tests.
// Asserts renderReviewMarkdown:
//  (a) slims ordinary readSet entry reason (empty/short) while preserving high_risk reason;
//  (b) merges the 审查维度 + 读取清单 tables into ONE combined table when slim ON
//      (the two old separate headers are not both present);
//  (c) slimReadSet OFF => full reason for all entries + two SEPARATE tables (old behavior);
//  (d) the report.slimReadSet.enabled flag defaults to true in route-rules.json.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReviewMarkdown } from './render-review-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTE_RULES = resolve(__dirname, '../config/route-rules.json');

// A review fixture with a precheck (lens dimensions) and a finalVerifierReadSet that
// mixes an ordinary entry and a high_risk entry, each carrying a substantive reason.
function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    reviewRequestId: 'req-rpt-test',
    verdict: 'pass',
    checkpoint: 'code-review',
    round: 1,
    findings: [],
    delegatedReviewBundle: { mode: 'delegated', topRisks: [], recommendedFinalReadSet: [] },
    finalVerifierReadSet: [
      {
        sourceType: 'candidate',
        target: 'src/ordinary.ts',
        reason: 'ordinary candidate file flagged by a subreviewer for routine inspection',
      },
      {
        sourceType: 'high_risk',
        target: 'server/internal/handler/auth.go',
        reason: 'HIGH_RISK_AUTH_REASON touches authentication boundary and must be read in full',
      },
    ],
    _delegatedPrecheck: {
      lenses: ['security', 'correctness'],
      reports: [
        { lens: 'security', report: { status: 'ok', candidateFindings: [], riskFlags: [] } },
        { lens: 'correctness', report: { status: 'ok', candidateFindings: [{}], riskFlags: [] } },
      ],
    },
    ...overrides,
  };
}

describe('render-review-report slimReadSet', () => {
  it('default flag report.slimReadSet.enabled reads true from route-rules.json', () => {
    const rules = JSON.parse(readFileSync(ROUTE_RULES, 'utf8'));
    expect(rules?.report?.slimReadSet?.enabled).toBe(true);
  });

  it('slims ordinary entry reason but preserves high_risk reason (slim ON)', () => {
    const md = renderReviewMarkdown(makeReview());
    // High-risk reason text must survive verbatim.
    expect(md).toContain('HIGH_RISK_AUTH_REASON');
    // Ordinary entry's substantive reason text must NOT appear (slimmed away).
    expect(md).not.toContain('ordinary candidate file flagged by a subreviewer');
    // The ordinary target itself still appears (only its reason is slimmed).
    expect(md).toContain('src/ordinary.ts');
  });

  it('merges lens-dimension + read-list into ONE table (slim ON)', () => {
    const md = renderReviewMarkdown(makeReview());
    // The two OLD separate section headers must NOT both be present when merged.
    const hasDimHeader = md.includes('### 审查维度');
    const hasReadHeader = md.includes('### 读取清单');
    expect(hasDimHeader && hasReadHeader).toBe(false);
    // The merged table must carry BOTH lens-dimension info and read-list info.
    expect(md).toContain('security'); // lens dimension
    expect(md).toContain('src/ordinary.ts'); // read-list target
    expect(md).toContain('server/internal/handler/auth.go'); // read-list target
  });

  it('slimReadSet OFF => full reason for all + two SEPARATE tables', () => {
    const md = renderReviewMarkdown(makeReview({ slimReadSet: false }));
    // Both old separate headers present (old behavior restored).
    expect(md).toContain('### 审查维度');
    expect(md).toContain('### 读取清单');
    // Full reason for the ordinary entry is restored.
    expect(md).toContain('ordinary candidate file flagged by a subreviewer');
    // High-risk reason still present.
    expect(md).toContain('HIGH_RISK_AUTH_REASON');
  });
});
