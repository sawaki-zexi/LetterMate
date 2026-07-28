import { describe, expect, it, vi } from 'vitest';
import { HackerNewsTrendSource } from './hacker-news.js';
import type { TrendWindow } from './types.js';

const window: TrendWindow = {
  windowStart: '2026-07-27T00:00:00.000Z', windowEnd: '2026-07-28T00:00:00.000Z',
  maxCandidates: 10, requestBudget: 3,
};

describe('HackerNewsTrendSource', () => {
  it('bounds item lookups and normalizes valid stories with canonical fallbacks', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([101, 102, 103]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 101, type: 'story', title: 'A new runtime', url: 'https://example.com/runtime', time: 1785196800,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 102, type: 'story', title: 'Ask HN: local agents?', time: 1785196860,
      }), { status: 200 }));
    const signal = new AbortController().signal;

    const result = await new HackerNewsTrendSource(fetcher as typeof fetch).collect(window, signal);

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://hacker-news.firebaseio.com/v0/topstories.json',
      'https://hacker-news.firebaseio.com/v0/item/101.json',
      'https://hacker-news.firebaseio.com/v0/item/102.json',
    ]);
    expect(fetcher.mock.calls.every(([, init]) => init.signal === signal)).toBe(true);
    expect(result).toEqual({ requestCount: 3, candidates: [
      { sourceId: 'hacker-news-trends', platform: 'Hacker News', externalId: '101', title: 'A new runtime', url: 'https://example.com/runtime', publishedAt: '2026-07-28T00:00:00.000Z' },
      { sourceId: 'hacker-news-trends', platform: 'Hacker News', externalId: '102', title: 'Ask HN: local agents?', url: 'https://news.ycombinator.com/item?id=102', publishedAt: '2026-07-28T00:01:00.000Z' },
    ] });
  });

  it('drops malformed, non-story, blank, and unsafe items', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([1, 2, 3, 4]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, type: 'comment', title: 'No', time: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 2, type: 'story', title: ' ', time: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 3, type: 'story', title: 'Unsafe', url: 'javascript:alert(1)', time: 1 }), { status: 200 }));
    const result = await new HackerNewsTrendSource(fetcher as typeof fetch).collect(
      { ...window, requestBudget: 4 }, new AbortController().signal,
    );
    expect(result.candidates).toEqual([]);
    expect(result.requestCount).toBe(4);
  });

  it('maps non-ok and malformed list responses to safe errors', async () => {
    const unavailable = new HackerNewsTrendSource(vi.fn().mockResolvedValue(new Response('body', { status: 503 })) as typeof fetch);
    await expect(unavailable.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_UNAVAILABLE', message: 'Hacker News is temporarily unavailable',
    });
    const malformed = new HackerNewsTrendSource(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ids: [1] }), { status: 200 })) as typeof fetch);
    await expect(malformed.collect(window, new AbortController().signal)).rejects.toMatchObject({ code: 'TREND_SOURCE_RESPONSE_INVALID' });
  });

  it('rejects an oversized JSON response before parsing it', async () => {
    const source = new HackerNewsTrendSource(vi.fn().mockResolvedValue(new Response('[]', {
      headers: { 'content-length': '600000' },
    })) as typeof fetch);
    await expect(source.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID', message: 'Hacker News returned an invalid response',
    });
  });

  it('maps HTTP 429 to the shared rate-limit failure code', async () => {
    const source = new HackerNewsTrendSource(vi.fn().mockResolvedValue(
      new Response('private body', { status: 429 }),
    ) as typeof fetch);
    await expect(source.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RATE_LIMITED', retryable: true,
    });
  });
});
