import { describe, expect, it } from 'vitest';
import { evaluateSourceQuality, type SourceQualityFunnelInput } from './source-quality-evaluation.js';

const windowStart = new Date('2026-08-09T00:00:00.000Z');
const windowEnd = new Date('2026-08-10T00:00:00.000Z');
const completeObservation = {
  expectedSampleCount: 1_441,
  observedSampleCount: 1_441,
  healthySampleCount: 1_441,
};

const source = (input: Partial<SourceQualityFunnelInput> & Pick<SourceQualityFunnelInput, 'source'>): SourceQualityFunnelInput => ({
  sourceType: 'web',
  successfulAttempts: 0,
  failedAttempts: 0,
  failureCodes: {},
  outcomes: {},
  ...input,
});

describe('evaluateSourceQuality', () => {
  it('reports a complete healthy window without manufacturing source problems', () => {
    const report = evaluateSourceQuality({
      windowStart,
      windowEnd,
      observation: completeObservation,
      sources: [
        source({
          source: 'source-a',
          successfulAttempts: 2,
          outcomes: { retrieved: 20, accepted: 2, keyword_rejected: 18 },
        }),
        source({
          source: 'source-b',
          sourceType: 'social',
          successfulAttempts: 1,
          outcomes: { retrieved: 10, accepted: 1, stale_rejected: 9 },
        }),
      ],
    });

    expect(report).toMatchObject({
      windowHours: 24,
      observationCoverage: 1,
      workerUptime: 1,
      totalAttempts: 3,
      totalRetrievedCount: 30,
      totalAcceptedCount: 3,
      decision: 'healthy',
      reasons: [],
    });
    expect(report.sources).toEqual([
      expect.objectContaining({
        source: 'source-a', acceptanceRate: 0.1, acceptedShare: 0.666667, reasons: [],
      }),
      expect.objectContaining({
        source: 'source-b', acceptanceRate: 0.1, acceptedShare: 0.333333, reasons: [],
      }),
    ]);
  });

  it('identifies repeated failures, zero candidates, low yield, and dominance independently', () => {
    const report = evaluateSourceQuality({
      windowStart,
      windowEnd,
      observation: completeObservation,
      sources: [
        source({
          source: 'dominant', successfulAttempts: 2,
          outcomes: { retrieved: 20, accepted: 10, keyword_rejected: 10 },
        }),
        source({ source: 'empty', successfulAttempts: 1 }),
        source({
          source: 'failing', failedAttempts: 5,
          failureCodes: { CONNECTOR_UPSTREAM_UNAVAILABLE: 5 },
        }),
        source({
          source: 'low-yield', successfulAttempts: 2,
          outcomes: { retrieved: 20, keyword_rejected: 20 },
        }),
      ],
    });

    expect(report.decision).toBe('review_required');
    expect(report.sources.find(({ source: name }) => name === 'dominant')?.reasons)
      .toEqual(['SINGLE_SOURCE_DOMINANCE']);
    expect(report.sources.find(({ source: name }) => name === 'empty')?.reasons)
      .toEqual(['SUCCESS_WITHOUT_CANDIDATES']);
    expect(report.sources.find(({ source: name }) => name === 'failing')?.reasons)
      .toEqual(['REPEATED_FAILURES']);
    expect(report.sources.find(({ source: name }) => name === 'low-yield')?.reasons)
      .toEqual(['LOW_ACCEPTANCE_YIELD']);
  });

  it('keeps an incomplete observation window in insufficient_data', () => {
    const report = evaluateSourceQuality({
      windowStart,
      windowEnd,
      observation: {
        expectedSampleCount: 1_441,
        observedSampleCount: 100,
        healthySampleCount: 80,
      },
      sources: [source({ source: 'source-a', successfulAttempts: 1, outcomes: { retrieved: 3 } })],
    });

    expect(report.decision).toBe('insufficient_data');
    expect(report.reasons).toEqual([
      'OBSERVATION_COVERAGE_BELOW_MINIMUM',
      'WORKER_UPTIME_BELOW_MINIMUM',
    ]);
  });

  it('rejects invalid aggregate counts', () => {
    expect(() => evaluateSourceQuality({
      windowStart,
      windowEnd,
      observation: completeObservation,
      sources: [source({ source: 'source-a', outcomes: { retrieved: -1 } })],
    })).toThrow('source-a.outcomes.retrieved must be a non-negative number');
  });
});
