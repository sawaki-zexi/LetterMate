import { describe, expect, it } from 'vitest';
import { runQualityEvaluation } from './quality-evaluation.js';

describe('offline quality evaluation', () => {
  it('runs deterministic fixtures through the production quality pipeline', async () => {
    const summary = await runQualityEvaluation();

    expect(summary).toMatchObject({ passed: true, caseCount: 2, failedCaseCount: 0 });
    expect(summary.reports).toEqual([
      expect.objectContaining({
        caseId: 'precise-version-boundary',
        passed: true,
        matchedForbiddenUrls: [],
        metrics: expect.objectContaining({ itemCount: 2, expectedRecall: 1 }),
      }),
      expect.objectContaining({
        caseId: 'technology-trend-proof',
        passed: true,
        metrics: expect.objectContaining({ itemCount: 1, expectedRecall: 1 }),
      }),
    ]);
  });
});
