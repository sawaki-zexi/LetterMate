import { describe, expect, it, vi } from 'vitest';
import { TwitterApiIoTrendSource } from './twitterapi-io.js';
import type { TrendSourceError, TrendWindow } from './types.js';

const window: TrendWindow = {
  windowStart: '2026-07-27T00:00:00.000Z', windowEnd: '2026-07-28T00:00:00.000Z',
  maxCandidates: 10, requestBudget: 1,
};

describe('TwitterApiIoTrendSource', () => {
  it('collects normalized X trend seeds within the WOEID request budget', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ trends: [
      { name: '#AgenticAI', query: '%23AgenticAI', tweet_volume: 1200 },
      { name: 123, query: 'invalid' },
      { name: '  ' },
      { name: 'x'.repeat(501), query: 'overlong-title' },
      { id: 'x'.repeat(501), name: 'Overlong ID' },
    ] }), { status: 200 }));
    const signal = new AbortController().signal;
    const source = new TwitterApiIoTrendSource({ apiKey: 'private-key', woeids: [1, 23424977] }, fetcher as typeof fetch);

    const result = await source.collect(window, signal);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.twitterapi.io/twitter/trends?woeid=1&count=30',
      { headers: { 'x-api-key': 'private-key' }, redirect: 'error', signal },
    );
    expect(result).toEqual({ requestCount: 1, candidates: [{
      sourceId: 'twitter-trends', platform: 'X Trends', externalId: '%23AgenticAI',
      title: '#AgenticAI', url: 'https://x.com/search?q=%23AgenticAI', publishedAt: null,
    }] });
    expect(result.candidates[0]).not.toHaveProperty('rank');
    expect(result.candidates[0]).not.toHaveProperty('score');
  });

  it('is enabled only with a configured key and maps failures without exposing it', async () => {
    expect(new TwitterApiIoTrendSource({ apiKey: undefined, woeids: [1] }).isEnabled()).toBe(false);
    const response = new Response('private upstream body', { status: 401 });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const source = new TwitterApiIoTrendSource({ apiKey: 'top-secret', woeids: [1] }, vi.fn()
      .mockResolvedValue(response) as typeof fetch);

    let error: unknown;
    try { await source.collect(window, new AbortController().signal); } catch (caught) { error = caught; }
    expect(error).toEqual(expect.objectContaining<Partial<TrendSourceError>>({
      code: 'TREND_SOURCE_AUTH_FAILED', message: 'TwitterAPI.io credentials are unavailable',
    }));
    expect(String(error)).not.toContain('top-secret');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not request or emit candidates when either output or request budget is zero', async () => {
    const fetcher = vi.fn();
    const source = new TwitterApiIoTrendSource({ apiKey: 'key', woeids: [1] }, fetcher as typeof fetch);

    await expect(source.collect({ ...window, maxCandidates: 0 }, new AbortController().signal))
      .resolves.toEqual({ candidates: [], requestCount: 0 });
    await expect(source.collect({ ...window, requestBudget: 0 }, new AbortController().signal))
      .resolves.toEqual({ candidates: [], requestCount: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed responses safely', async () => {
    const source = new TwitterApiIoTrendSource({ apiKey: 'key', woeids: [1] }, vi.fn()
      .mockResolvedValue(new Response(JSON.stringify({ trends: 'not-an-array' }), { status: 200 })) as typeof fetch);
    await expect(source.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID', retryable: false,
    });
  });

  it('rejects an oversized JSON response before parsing it', async () => {
    const response = new Response(JSON.stringify({ trends: [] }), {
      headers: { 'content-length': '600000' },
    });
    const source = new TwitterApiIoTrendSource({ apiKey: 'key', woeids: [1] }, vi.fn().mockResolvedValue(response) as typeof fetch);
    await expect(source.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID', message: 'TwitterAPI.io returned an invalid response',
    });
  });
});
