import { validateSourceCandidate, type ValidatedSourceCandidate } from '@lettermate/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  recordSourceAttemptSafely,
  recordSourceCandidatesSafely,
  recordSourceDifferenceSafely,
} from './source-observability.js';

const candidate = (
  connectorId: string,
  sourceType: ValidatedSourceCandidate['sourceType'],
  id: string,
) => validateSourceCandidate({
  connectorId,
  sourceType,
  platform: connectorId,
  externalId: id,
  url: `https://example.com/${connectorId}/${id}`,
  title: `Candidate ${id}`,
  content: 'A substantive candidate with implementation details and measurements.',
  excerpt: null,
  authorName: null,
  authorHandle: null,
  publishedAt: '2026-08-10T00:00:00.000Z',
  language: 'en',
  engagement: {},
  proof: {
    kind: 'api_record' as const,
    connectorId,
    externalId: id,
  },
});

describe('source observability', () => {
  it('aggregates candidate outcomes by stable connector and source type', () => {
    const sink = { recordSourceAttempt: vi.fn(), recordSourceItems: vi.fn() };
    recordSourceCandidatesSafely(sink, [
      candidate('github', 'code', '1'),
      candidate('github', 'code', '2'),
      candidate('tavily', 'web', '3'),
    ], 'retrieved');

    expect(sink.recordSourceItems.mock.calls.map(([input]) => input)).toEqual([
      { source: 'github', sourceType: 'code', outcome: 'retrieved', count: 2 },
      { source: 'tavily', sourceType: 'web', outcome: 'retrieved', count: 1 },
    ]);
  });

  it('records only the aggregate loss between two funnel stages', () => {
    const sink = { recordSourceAttempt: vi.fn(), recordSourceItems: vi.fn() };
    const github = [candidate('github', 'code', '1'), candidate('github', 'code', '2')];
    const tavily = candidate('tavily', 'web', '3');

    recordSourceDifferenceSafely(
      sink,
      [...github, tavily],
      [github[0]!, tavily],
      'duplicate_rejected',
    );

    expect(sink.recordSourceItems).toHaveBeenCalledOnce();
    expect(sink.recordSourceItems).toHaveBeenCalledWith({
      source: 'github', sourceType: 'code', outcome: 'duplicate_rejected', count: 1,
    });
  });

  it('contains telemetry failures', () => {
    const sink = {
      recordSourceAttempt: vi.fn(() => { throw new Error('metrics unavailable'); }),
      recordSourceItems: vi.fn(() => { throw new Error('metrics unavailable'); }),
    };

    expect(() => recordSourceAttemptSafely(sink, {
      source: 'github', sourceType: 'code', result: 'success',
    })).not.toThrow();
    expect(() => recordSourceCandidatesSafely(
      sink,
      [candidate('github', 'code', '1')],
      'accepted',
    )).not.toThrow();
  });
});
