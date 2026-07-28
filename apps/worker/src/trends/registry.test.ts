import { describe, expect, it, vi } from 'vitest';
import { TrendSourceRegistry } from './registry.js';
import { RedditTrendSource } from './reddit.js';
import {
  TrendSourceError,
  type TrendSeedCandidate,
  type TrendSource,
  type TrendSourceResult,
  type TrendWindow,
} from './types.js';

const window: TrendWindow = {
  windowStart: '2026-07-27T00:00:00.000Z',
  windowEnd: '2026-07-28T00:00:00.000Z',
  maxCandidates: 3,
  requestBudget: 6,
};

const candidate = (sourceId: string, id: string, url = `https://example.com/${id}`): TrendSeedCandidate => ({
  sourceId,
  platform: sourceId,
  externalId: id,
  title: `Trend ${id}`,
  url,
  publishedAt: null,
});

const source = (id: string, overrides: Partial<TrendSource> = {}): TrendSource => ({
  id,
  label: id,
  isEnabled: () => true,
  collect: async () => ({ candidates: [], requestCount: 0 }),
  ...overrides,
});

describe('TrendSourceRegistry', () => {
  it('filters disabled sources, bounds concurrency and divides the request budget', async () => {
    let active = 0;
    let maximumActive = 0;
    const budgets: number[] = [];
    const releases: Array<() => void> = [];
    const delayed = (id: string) => source(id, { collect: async (receivedWindow) => {
      budgets.push(receivedWindow.requestBudget);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { candidates: [], requestCount: receivedWindow.requestBudget };
    } });
    const registry = new TrendSourceRegistry([
      source('disabled', { isEnabled: () => false }),
      delayed('one'), delayed('two'), delayed('three'),
    ], { concurrency: 2, timeoutMs: 1_000 });

    const pending = registry.collect(window);
    await Promise.resolve();
    expect(releases).toHaveLength(2);
    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(3);
    releases[1]?.(); releases[2]?.();

    await expect(pending).resolves.toMatchObject({
      successfulSourceIds: ['one', 'two', 'three'],
      skippedSourceIds: ['disabled'],
      requestCount: 6,
      requestCounts: { one: 2, two: 2, three: 2 },
    });
    expect(maximumActive).toBe(2);
    expect(budgets).toEqual([2, 2, 2]);
  });

  it('strictly validates candidates, canonicalizes HTTP URLs, and deduplicates', async () => {
    const invalid = { ...candidate('one', 'bad'), rank: 1 } as unknown as TrendSeedCandidate;
    const registry = new TrendSourceRegistry([
      source('one', { collect: async () => ({ candidates: [
        candidate('one', 'a', 'HTTPS://Example.com:443/path/?utm_source=test#fragment'),
        candidate('one', 'a', 'https://example.com/other'),
        invalid,
      ], requestCount: 1 }) }),
      source('two', { collect: async () => ({ candidates: [
        candidate('two', 'b', 'https://example.com/path'),
        candidate('two', 'unsafe', 'javascript:alert(1)'),
      ], requestCount: 1 }) }),
    ], { concurrency: 2, timeoutMs: 1_000 });

    const result = await registry.collect({ ...window, maxCandidates: 10 });

    expect(result.candidates).toEqual([]);
    expect(result.successfulSourceIds).toEqual([]);
    expect(result.failures.map(({ sourceId, code }) => ({ sourceId, code }))).toEqual([
      { sourceId: 'one', code: 'TREND_SOURCE_RESPONSE_INVALID' },
      { sourceId: 'two', code: 'TREND_SOURCE_RESPONSE_INVALID' },
    ]);
    expect(JSON.stringify(result)).not.toContain('javascript');
  });

  it('rejects candidate URLs containing credentials', async () => {
    const registry = new TrendSourceRegistry([
      source('credential-url', { collect: async () => ({
        candidates: [candidate('credential-url', 'private', 'https://user:password@example.com/trend')],
        requestCount: 1,
      }) }),
    ], { concurrency: 1, timeoutMs: 1_000 });

    await expect(registry.collect(window)).resolves.toMatchObject({
      candidates: [],
      failures: [{ sourceId: 'credential-url', code: 'TREND_SOURCE_RESPONSE_INVALID' }],
    });
  });

  it('round-robins valid source results, canonicalizes URLs, and caps output', async () => {
    const registry = new TrendSourceRegistry([
      source('one', { collect: async () => ({ candidates: [
        candidate('one', 'a', 'HTTPS://Example.com:443/a/?utm_source=x#fragment'),
        candidate('one', 'b'),
      ], requestCount: 1 }) }),
      source('two', { collect: async () => ({ candidates: [candidate('two', 'c')], requestCount: 1 }) }),
    ], { concurrency: 2, timeoutMs: 1_000 });

    const result = await registry.collect(window);

    expect(result.candidates.map(({ externalId }) => externalId)).toEqual(['a', 'c', 'b']);
    expect(result.candidates[0]?.url).toBe('https://example.com/a');
  });

  it('isolates safe failures and never exposes private errors', async () => {
    const registry = new TrendSourceRegistry([
      source('safe', { collect: async () => { throw new TrendSourceError('TREND_RATE_LIMITED', 'Trend source rate limited', true); } }),
      source('private', { collect: async () => { throw new Error('secret upstream body and stack'); } }),
      source('working', { collect: async () => ({ candidates: [candidate('working', 'ok')], requestCount: 1 }) }),
    ], { concurrency: 3, timeoutMs: 1_000 });

    const result = await registry.collect(window);

    expect(result.candidates).toHaveLength(1);
    expect(result.failures).toEqual([
      { sourceId: 'safe', code: 'TREND_RATE_LIMITED', message: 'Trend source rate limited', retryable: true },
      { sourceId: 'private', code: 'TREND_SOURCE_UNAVAILABLE', message: 'Trend source is temporarily unavailable', retryable: true },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('aborts timed-out sources without waiting for late rejections', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const registry = new TrendSourceRegistry([source('slow', { collect: async (_window, signal) => {
        observedSignal = signal;
        return new Promise<TrendSourceResult>((_resolve, reject) => setTimeout(() => reject(new Error('late secret')), 50));
      } })], { concurrency: 1, timeoutMs: 10 });

      const pending = registry.collect(window);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({
        failures: [{ sourceId: 'slow', code: 'TREND_SOURCE_TIMEOUT' }],
      });
      expect(observedSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      vi.useRealTimers();
    }
  });

  it('retains a hung source request count after timeout', async () => {
    vi.useFakeTimers();
    try {
      const hung = source('hung', { collect: async (receivedWindow) => {
        (receivedWindow as TrendWindow & { recordRequest?: () => void }).recordRequest?.();
        return new Promise<TrendSourceResult>(() => undefined);
      } });
      const registry = new TrendSourceRegistry([hung], { concurrency: 1, timeoutMs: 10 });
      const pending = registry.collect(window);
      await vi.advanceTimersByTimeAsync(10);

      await expect(pending).resolves.toMatchObject({
        requestCount: 1,
        requestCounts: { hung: 1 },
        failures: [{ sourceId: 'hung', code: 'TREND_SOURCE_TIMEOUT' }],
      });
    } finally { vi.useRealTimers(); }
  });

  it('retains both Reddit requests when the listing fails', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'temporary-token', token_type: 'bearer', expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('private listing body', { status: 503 }));
    const reddit = new RedditTrendSource({
      clientId: 'id', clientSecret: 'secret', communities: ['programming'],
    }, fetcher as typeof fetch);
    const registry = new TrendSourceRegistry([reddit], { concurrency: 1, timeoutMs: 1_000 });

    const result = await registry.collect(window);

    expect(result).toMatchObject({
      requestCount: 2,
      requestCounts: { 'reddit-trends': 2 },
      failures: [{ sourceId: 'reddit-trends', code: 'TREND_SOURCE_UNAVAILABLE' }],
    });
  });

  it('allocates only useful minimum request budgets', async () => {
    const received: Array<[string, number]> = [];
    const costSource = (id: string, minimumRequestBudget: number): TrendSource => ({
      ...source(id),
      minimumRequestBudget,
      collect: async (receivedWindow) => {
        received.push([id, receivedWindow.requestBudget]);
        return { candidates: [], requestCount: receivedWindow.requestBudget };
      },
    } as TrendSource);
    const registry = new TrendSourceRegistry([
      costSource('one', 1), costSource('two', 2), costSource('three', 1),
      costSource('four', 2), costSource('five', 1), costSource('six', 1),
    ], { concurrency: 6, timeoutMs: 1_000 });

    const result = await registry.collect(window);

    expect(received).toEqual([['one', 1], ['two', 2], ['three', 1], ['four', 2]]);
    expect(result.skippedSourceIds).toEqual(['five', 'six']);
    expect(result.requestCount).toBe(6);
  });

  it('rotates source priority across repeated low-budget collections', async () => {
    const called: string[] = [];
    const rotating = (id: string): TrendSource => source(id, { collect: async () => {
      called.push(id);
      return { candidates: [], requestCount: 1 };
    } });
    const registry = new TrendSourceRegistry([
      rotating('one'), rotating('two'), rotating('three'),
    ], { concurrency: 1, timeoutMs: 1_000 });

    await registry.collect({ ...window, requestBudget: 1 });
    await registry.collect({ ...window, requestBudget: 1 });
    await registry.collect({ ...window, requestBudget: 1 });

    expect(called).toEqual(['one', 'two', 'three']);
  });

  it('rejects duplicate IDs and invalid options or windows', async () => {
    expect(() => new TrendSourceRegistry([source('same'), source('same')], { concurrency: 1, timeoutMs: 10 })).toThrow('Duplicate');
    expect(() => new TrendSourceRegistry([], { concurrency: 0, timeoutMs: 10 })).toThrow('concurrency');
    expect(() => new TrendSourceRegistry([], { concurrency: 1, timeoutMs: 0 })).toThrow('timeoutMs');
    const registry = new TrendSourceRegistry([], { concurrency: 1, timeoutMs: 10 });
    await expect(registry.collect({ ...window, requestBudget: -1 })).rejects.toThrow('requestBudget');
  });
});
