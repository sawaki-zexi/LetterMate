import { describe, expect, it, vi } from 'vitest';
import { parseSourceQualityCliOptions, readSourceQualityReport } from './source-quality-evaluation.js';

const vector = (result: unknown[]) => new Response(JSON.stringify({
  status: 'success',
  data: { resultType: 'vector', result },
}), { status: 200 });

const matrix = (values: Array<[number, string]>) => new Response(JSON.stringify({
  status: 'success',
  data: { resultType: 'matrix', result: [{ metric: {}, values }] },
}), { status: 200 });

describe('source quality Prometheus evaluation', () => {
  it('queries bounded source aggregates and verifies the complete observation window', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z');
    const uptimeValues = Array.from({ length: 1_441 }, (_, index) => [
      now.getTime() / 1_000 - (1_440 - index) * 60,
      '1',
    ] as [number, string]);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const query = url.searchParams.get('query') ?? '';
      if (url.pathname.endsWith('/query_range')) return matrix(uptimeValues);
      if (query.includes('source_attempts')) return vector([
        { metric: { source: 'twitterapi-io', source_type: 'social', result: 'success', code: 'none' }, value: [1, '1'] },
        { metric: { source: 'openrouter-search', source_type: 'web', result: 'failure', code: 'CONNECTOR_CREDIT_EXHAUSTED' }, value: [1, '1'] },
      ]);
      return vector([
        { metric: { source: 'twitterapi-io', source_type: 'social', outcome: 'retrieved' }, value: [1, '20'] },
        { metric: { source: 'twitterapi-io', source_type: 'social', outcome: 'accepted' }, value: [1, '2'] },
        { metric: { source: 'twitterapi-io', source_type: 'social', outcome: 'keyword_rejected' }, value: [1, '18'] },
      ]);
    });

    const report = await readSourceQualityReport({
      prometheusUrl: 'http://127.0.0.1:9090',
      hours: 24,
      now,
      fetcher: fetcher as typeof fetch,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    const requestedUrls = fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(requestedUrls.filter((url) => url.pathname.endsWith('/query'))).toHaveLength(2);
    expect(requestedUrls.find((url) => url.pathname.endsWith('/query_range'))?.searchParams.get('query'))
      .toBe('max(up{job="lettermate-worker"})');
    expect(report).toMatchObject({
      decision: 'healthy',
      observationCoverage: 1,
      workerUptime: 1,
      totalRetrievedCount: 20,
      totalAcceptedCount: 2,
    });
    expect(report.sources).toEqual([
      expect.objectContaining({
        source: 'openrouter-search',
        failedAttempts: 1,
        failureCodes: { CONNECTOR_CREDIT_EXHAUSTED: 1 },
      }),
      expect.objectContaining({
        source: 'twitterapi-io',
        successfulAttempts: 1,
        acceptanceRate: 0.1,
      }),
    ]);
  });

  it('validates CLI boundaries and provider responses', async () => {
    expect(parseSourceQualityCliOptions(undefined, undefined)).toEqual({
      prometheusUrl: 'http://127.0.0.1:9090/',
      hours: 24,
    });
    expect(() => parseSourceQualityCliOptions('ftp://localhost', '24'))
      .toThrow('Prometheus URL must use HTTP(S) without embedded credentials');
    expect(() => parseSourceQualityCliOptions('http://user:secret@localhost', '24'))
      .toThrow('Prometheus URL must use HTTP(S) without embedded credentials');
    expect(() => parseSourceQualityCliOptions('http://localhost:9090', '0'))
      .toThrow('hours must be an integer between 1 and 168');

    await expect(readSourceQualityReport({
      prometheusUrl: 'http://127.0.0.1:9090',
      hours: 24,
      fetcher: vi.fn().mockImplementation(async () => new Response('{}', { status: 200 })) as typeof fetch,
    })).rejects.toThrow('Prometheus returned an unexpected query response');

    await expect(readSourceQualityReport({
      prometheusUrl: 'http://127.0.0.1:9090',
      hours: 24,
      fetcher: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as typeof fetch,
    })).rejects.toThrow('Prometheus is unavailable');
  });
});
