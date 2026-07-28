import { describe, expect, it, vi } from 'vitest';
import { YouTubeTrendSource } from './youtube.js';
import type { TrendWindow } from './types.js';

const window: TrendWindow = {
  windowStart: '2026-07-27T00:00:00.000Z', windowEnd: '2026-07-28T00:00:00.000Z',
  maxCandidates: 5, requestBudget: 1,
};

describe('YouTubeTrendSource', () => {
  it('requests official most-popular videos and returns normalized seeds', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{
      id: 'abc_DEF-123',
      snippet: { title: 'Agent runtime demo', publishedAt: '2026-07-27T12:00:00.000Z' },
      statistics: { viewCount: '1000' },
    }, {
      id: 123,
      snippet: { title: 'Malformed sibling', publishedAt: '2026-07-27T12:00:00Z' },
    }, {
      id: 'blankTitle',
      snippet: { title: '  ', publishedAt: '2026-07-27T12:00:00Z' },
    }, {
      id: 'longTitle',
      snippet: { title: 'x'.repeat(501), publishedAt: '2026-07-27T12:00:00Z' },
    }] }), { status: 200 }));
    const signal = new AbortController().signal;
    const result = await new YouTubeTrendSource({ apiKey: 'private-key', region: 'JP', maxResults: 20 }, fetcher as typeof fetch)
      .collect(window, signal);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.googleapis.com/youtube/v3/videos');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      part: 'snippet,statistics', chart: 'mostPopular', regionCode: 'JP', maxResults: '20', key: 'private-key',
    });
    expect(init).toEqual({ redirect: 'error', signal });
    expect(result).toEqual({ requestCount: 1, candidates: [{
      sourceId: 'youtube-trends', platform: 'YouTube', externalId: 'abc_DEF-123',
      title: 'Agent runtime demo', url: 'https://www.youtube.com/watch?v=abc_DEF-123',
      publishedAt: '2026-07-27T12:00:00.000Z',
    }] });
  });

  it('is disabled without a key and does not request with no budget', async () => {
    expect(new YouTubeTrendSource({ apiKey: undefined, region: 'US' }).isEnabled()).toBe(false);
    const fetcher = vi.fn();
    const result = await new YouTubeTrendSource({ apiKey: 'key', region: 'US' }, fetcher as typeof fetch)
      .collect({ ...window, requestBudget: 0 }, new AbortController().signal);
    expect(result).toEqual({ candidates: [], requestCount: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts standard RFC3339 timestamp forms and canonicalizes them to ISO', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [
      { id: 'noFraction', snippet: { title: 'No fraction', publishedAt: '2026-07-27T12:00:00Z' } },
      { id: 'offsetTime', snippet: { title: 'Offset', publishedAt: '2026-07-27T20:00:00+08:00' } },
      { id: 'fractional', snippet: { title: 'Fraction', publishedAt: '2026-07-27T12:00:00.123Z' } },
    ] }), { status: 200 }));

    const result = await new YouTubeTrendSource({ apiKey: 'key', region: 'US' }, fetcher as typeof fetch)
      .collect({ ...window, maxCandidates: 3 }, new AbortController().signal);

    expect(result.candidates.map(({ publishedAt }) => publishedAt)).toEqual([
      '2026-07-27T12:00:00.000Z',
      '2026-07-27T12:00:00.000Z',
      '2026-07-27T12:00:00.123Z',
    ]);
  });

  it('drops invalid timestamp items and maps API failures safely', async () => {
    const malformed = new YouTubeTrendSource({ apiKey: 'key', region: 'US' }, vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: 'video123', snippet: { title: 'Title', publishedAt: '2026-02-31T12:00:00Z' } }] }), { status: 200 }),
    ) as typeof fetch);
    await expect(malformed.collect(window, new AbortController().signal)).resolves.toEqual({
      candidates: [], requestCount: 1,
    });
    const deniedResponse = new Response('secret body', { status: 403 });
    const cancel = vi.spyOn(deniedResponse.body!, 'cancel');
    const denied = new YouTubeTrendSource({ apiKey: 'key', region: 'US' }, vi.fn().mockResolvedValue(deniedResponse) as typeof fetch);
    await expect(denied.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_AUTH_FAILED', message: 'YouTube credentials are unavailable',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects an oversized JSON response before parsing it', async () => {
    const source = new YouTubeTrendSource({ apiKey: 'key', region: 'US' }, vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { headers: { 'content-length': '600000' } }),
    ) as typeof fetch);
    await expect(source.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID', message: 'YouTube returned an invalid response',
    });
  });
});
