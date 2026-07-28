import { describe, expect, it, vi } from 'vitest';
import { GoogleRssTrendSource } from './google-rss.js';
import type { TrendWindow } from './types.js';

const window: TrendWindow = {
  windowStart: '2026-07-27T00:00:00.000Z', windowEnd: '2026-07-28T00:00:00.000Z',
  maxCandidates: 10, requestBudget: 1,
};

describe('GoogleRssTrendSource', () => {
  it('parses common RSS item shapes and bounds configured feed requests', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Daily Trends</title>
      <item><title>AI agents</title><guid>trend-ai-agents</guid><link>https://trends.google.com/trends/explore?q=AI%20agents&amp;geo=US</link><pubDate>Mon, 27 Jul 2026 12:00:00 GMT</pubDate></item>
      <item><title>Unsafe</title><link>javascript:alert(1)</link><pubDate>bad date</pubDate></item>
    </channel></rss>`;
    const fetcher = vi.fn().mockResolvedValue(new Response(xml, { status: 200 }));
    const signal = new AbortController().signal;
    const source = new GoogleRssTrendSource({ feedUrls: ['https://example.com/us.xml', 'https://example.com/gb.xml'] }, fetcher as typeof fetch);

    const result = await source.collect(window, signal);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://example.com/us.xml', { signal });
    expect(result).toEqual({ requestCount: 1, candidates: [{
      sourceId: 'google-trends-rss', platform: 'Google Trends', externalId: 'trend-ai-agents',
      title: 'AI agents', url: 'https://trends.google.com/trends/explore?q=AI%20agents&geo=US',
      publishedAt: '2026-07-27T12:00:00.000Z',
    }] });
  });

  it('is enabled only for configured HTTPS feeds', () => {
    expect(new GoogleRssTrendSource({ feedUrls: [] }).isEnabled()).toBe(false);
    expect(() => new GoogleRssTrendSource({ feedUrls: ['http://example.com/feed.xml'] })).toThrow('HTTPS');
    expect(() => new GoogleRssTrendSource({ feedUrls: ['not a URL'] })).toThrow('HTTPS');
  });

  it('rejects malformed XML and non-ok responses with safe errors', async () => {
    const malformed = new GoogleRssTrendSource({ feedUrls: ['https://example.com/feed.xml'] }, vi.fn()
      .mockResolvedValue(new Response('<rss><channel>', { status: 200 })) as typeof fetch);
    await expect(malformed.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID', message: 'Google Trends RSS returned invalid XML',
    });
    const unavailable = new GoogleRssTrendSource({ feedUrls: ['https://example.com/feed.xml'] }, vi.fn()
      .mockResolvedValue(new Response('private body', { status: 500 })) as typeof fetch);
    await expect(unavailable.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_UNAVAILABLE', message: 'Google Trends RSS is temporarily unavailable',
    });
  });
});
