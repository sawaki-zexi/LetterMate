import type { DiscoveryCandidate } from '@lettermate/contracts';
import { describe, expect, it } from 'vitest';
import { evaluateDiscoveryOutput } from './evaluation.js';

const item = (url: string, overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate => ({
  kind: 'quality',
  title: 'GPT-5.7 工程更新',
  summary: '正文说明了版本变化和可复现的实现细节。',
  reason: '包含可回溯的一手来源。',
  sourceUrls: [url],
  publishedAt: '2026-08-08T08:00:00.000Z',
  sourceType: 'web',
  platform: 'Example',
  authorName: null,
  authorHandle: null,
  externalId: null,
  provenanceKind: 'fetched_page',
  ...overrides,
});

describe('discovery output evaluation', () => {
  it('passes a complete, localized, deduplicated golden set', () => {
    const report = evaluateDiscoveryOutput({
      caseId: 'precise-version',
      items: [
        item('https://example.com/release?utm_source=test'),
        item('https://example.com/guide'),
      ],
      expectedUrls: ['https://example.com/release', 'https://example.com/guide'],
      forbiddenUrls: ['https://example.com/gpt-5-7-1'],
    });

    expect(report).toMatchObject({
      passed: true,
      failures: [],
      metrics: {
        expectedRecall: 1,
        forbiddenHitRate: 0,
        sourceCoverage: 1,
        chineseCoverage: 1,
        duplicateRate: 0,
      },
    });
  });

  it('reports independent quality regressions without exposing internal scores', () => {
    const report = evaluateDiscoveryOutput({
      caseId: 'regression',
      items: [
        item('https://example.com/forbidden'),
        item('https://example.com/forbidden', {
          title: 'English only', summary: 'No localized summary', reason: 'No localized reason',
          sourceUrls: ['file:///private/source'],
        }),
      ],
      expectedUrls: ['https://example.com/expected'],
      forbiddenUrls: ['https://example.com/forbidden'],
    });

    expect(report.passed).toBe(false);
    expect(report.failures).toEqual([
      'EXPECTED_RECALL_BELOW_TARGET',
      'FORBIDDEN_HIT_RATE_ABOVE_LIMIT',
      'SOURCE_COVERAGE_BELOW_TARGET',
      'CHINESE_COVERAGE_BELOW_TARGET',
    ]);
    expect(report.missingExpectedUrls).toEqual(['https://example.com/expected']);
    expect(report.matchedForbiddenUrls).toEqual(['https://example.com/forbidden']);
  });

  it('supports explicit thresholds and rejects invalid threshold configuration', () => {
    expect(evaluateDiscoveryOutput({
      caseId: 'partial-recall',
      items: [item('https://example.com/one')],
      expectedUrls: ['https://example.com/one', 'https://example.com/two'],
      thresholds: { minimumExpectedRecall: 0.5 },
    }).passed).toBe(true);

    expect(() => evaluateDiscoveryOutput({
      caseId: 'invalid-threshold',
      items: [],
      expectedUrls: [],
      thresholds: { maximumDuplicateRate: 1.1 },
    })).toThrow(/between 0 and 1/);
  });

  it('rejects forbidden secondary sources and mostly-English localized fields', () => {
    const report = evaluateDiscoveryOutput({
      caseId: 'secondary-forbidden-and-weak-localization',
      items: [item('https://example.com/allowed', {
        sourceUrls: [
          'https://example.com/allowed',
          'https://example.com/forbidden-version',
        ],
        title: 'English release notes 中',
        summary: 'Detailed implementation analysis 中',
        reason: 'Useful engineering context 中',
      })],
      expectedUrls: ['https://example.com/allowed'],
      forbiddenUrls: ['https://example.com/forbidden-version'],
    });

    expect(report.failures).toEqual([
      'FORBIDDEN_HIT_RATE_ABOVE_LIMIT',
      'CHINESE_COVERAGE_BELOW_TARGET',
    ]);
    expect(report.matchedForbiddenUrls).toEqual(['https://example.com/forbidden-version']);
  });
});
