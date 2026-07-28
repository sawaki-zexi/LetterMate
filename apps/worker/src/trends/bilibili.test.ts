import { describe, expect, it, vi } from 'vitest';
import { BilibiliTrendSource } from './bilibili.js';
import type { TrendWindow } from './types.js';

const window: TrendWindow = {
  windowStart: '2026-07-27T00:00:00.000Z', windowEnd: '2026-07-28T00:00:00.000Z',
  maxCandidates: 5, requestBudget: 1,
};

describe('BilibiliTrendSource', () => {
  it('collects the public popular list as normalized video seeds', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { list: [{
      bvid: 'BV1xx411c7mD', title: '<em>开源</em> Agent 运行时', pubdate: 1785196800,
      stat: { view: 999 },
    }] } }), { status: 200 }));
    const signal = new AbortController().signal;

    const result = await new BilibiliTrendSource({ limit: 20 }, fetcher as typeof fetch).collect(window, signal);

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20',
      { headers: { accept: 'application/json', 'user-agent': 'LetterMate/0.1' }, signal },
    );
    expect(result).toEqual({ requestCount: 1, candidates: [{
      sourceId: 'bilibili-trends', platform: 'Bilibili', externalId: 'BV1xx411c7mD',
      title: '开源 Agent 运行时', url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      publishedAt: '2026-07-28T00:00:00.000Z',
    }] });
    expect(result.candidates[0]).not.toHaveProperty('stat');
  });

  it('is always enabled and honors a zero request budget', async () => {
    const fetcher = vi.fn();
    const source = new BilibiliTrendSource({}, fetcher as typeof fetch);
    expect(source.isEnabled()).toBe(true);
    await expect(source.collect({ ...window, requestBudget: 0 }, new AbortController().signal))
      .resolves.toEqual({ candidates: [], requestCount: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires code zero and safely maps HTTP failures', async () => {
    const rejected = new BilibiliTrendSource({}, vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: -412, message: 'private response' }), { status: 200 }),
    ) as typeof fetch);
    await expect(rejected.collect(window, new AbortController().signal)).rejects.toMatchObject({ code: 'TREND_SOURCE_RESPONSE_INVALID' });
    const unavailable = new BilibiliTrendSource({}, vi.fn().mockResolvedValue(new Response('body', { status: 503 })) as typeof fetch);
    await expect(unavailable.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_UNAVAILABLE', message: 'Bilibili is temporarily unavailable',
    });
  });
});
