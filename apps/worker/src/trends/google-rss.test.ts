import { describe, expect, it, vi } from 'vitest';
import { ContentFetcher } from '../content-fetcher.js';
import { GoogleRssTrendSource } from './google-rss.js';
import { TrendSourceRegistry } from './registry.js';
import type { TrendWindow } from './types.js';

const window: TrendWindow = {
  windowStart: '2026-07-27T00:00:00.000Z', windowEnd: '2026-07-28T00:00:00.000Z',
  maxCandidates: 10, requestBudget: 1,
};

const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];
const xmlResponse = (body: string, init: ResponseInit = {}) => new Response(body, {
  ...init,
  headers: { 'content-type': 'application/rss+xml; charset=utf-8', ...init.headers },
});
const sourceWith = (
  feedUrls: string[],
  request: typeof fetch,
  options: { maxBytes?: number } = {},
) => new GoogleRssTrendSource(
  { feedUrls },
  new ContentFetcher({ resolveHostname: publicResolver, ...options }, request),
);

describe('GoogleRssTrendSource', () => {
  it('parses common RSS item shapes and bounds configured feed requests', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Daily Trends</title>
      <item><title>AI agents</title><guid>trend-ai-agents</guid><link>https://trends.google.com/trends/explore?q=AI%20agents&amp;geo=US</link><pubDate>Mon, 27 Jul 2026 12:00:00 GMT</pubDate></item>
      <item><title>Unsafe</title><link>javascript:alert(1)</link><pubDate>bad date</pubDate></item>
    </channel></rss>`;
    const fetcher = vi.fn().mockResolvedValue(xmlResponse(xml));
    const signal = new AbortController().signal;
    const source = sourceWith(
      ['https://example.com/us.xml?geo=US', 'https://example.com/gb.xml?geo=GB'],
      fetcher as typeof fetch,
    );

    const result = await source.collect(window, signal);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('https://example.com/us.xml?geo=US');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', signal });
    expect(result).toEqual({ requestCount: 1, candidates: [{
      sourceId: 'google-trends-rss', platform: 'Google Trends', externalId: 'trend-ai-agents',
      title: 'AI agents', url: 'https://trends.google.com/trends/explore?q=AI+agents&geo=US',
      publishedAt: '2026-07-27T12:00:00.000Z',
    }] });
  });

  it('keeps distinct live Google trend items despite their repeated feed link', async () => {
    const liveXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel>
        <item><title>AI Agents</title><ht:approx_traffic>200+</ht:approx_traffic><link>https://trends.google.com/trending/rss?geo=US</link><pubDate>Mon, 27 Jul 2026 12:00:00 GMT</pubDate></item>
        <item><title>Local Models</title><ht:approx_traffic>500+</ht:approx_traffic><link>https://trends.google.com/trending/rss?geo=US</link><pubDate>Mon, 27 Jul 2026 13:00:00 GMT</pubDate></item>
        <item><title>${'x'.repeat(501)}</title><link>https://trends.google.com/trending/rss?geo=US</link><pubDate>Mon, 27 Jul 2026 14:00:00 GMT</pubDate></item>
      </channel></rss>`;
    const source = sourceWith(
      ['https://trends.google.com/trending/rss?geo=US'],
      vi.fn().mockResolvedValue(xmlResponse(liveXml)) as typeof fetch,
    );
    const registry = new TrendSourceRegistry([source], { concurrency: 1, timeoutMs: 1_000 });

    const result = await registry.collect(window);

    expect(result.candidates.map(({ externalId }) => externalId)).toEqual([
      'US:ai agents', 'US:local models',
    ]);
    expect(result.candidates.map(({ url }) => url)).toEqual([
      'https://trends.google.com/trends/explore?geo=US&q=AI+Agents',
      'https://trends.google.com/trends/explore?geo=US&q=Local+Models',
    ]);
  });

  it('decodes only predefined and numeric XML references for title identity and URL', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>R&amp;D &#x1F680;</title><link>https://trends.google.com/trending/rss?geo=US</link><pubDate>Mon, 27 Jul 2026 12:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const source = sourceWith(
      ['https://trends.google.com/trending/rss?geo=US'],
      vi.fn().mockResolvedValue(xmlResponse(xml)) as typeof fetch,
    );

    const result = await source.collect(window, new AbortController().signal);

    expect(result.candidates[0]).toMatchObject({
      title: 'R&D 🚀',
      externalId: 'US:r&d 🚀',
    });
    expect(new URL(result.candidates[0]!.url).searchParams.get('q')).toBe('R&D 🚀');
  });

  it('is enabled only for configured HTTPS feeds', () => {
    expect(new GoogleRssTrendSource({ feedUrls: [] }).isEnabled()).toBe(false);
    expect(() => new GoogleRssTrendSource({ feedUrls: ['http://example.com/feed.xml'] })).toThrow('HTTPS');
    expect(() => new GoogleRssTrendSource({ feedUrls: ['not a URL'] })).toThrow('HTTPS');
  });

  it('rejects malformed XML and non-ok responses with safe errors', async () => {
    const malformed = sourceWith(['https://example.com/feed.xml'], vi.fn()
      .mockResolvedValue(xmlResponse('<rss><channel>')) as typeof fetch);
    await expect(malformed.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID', message: 'Google Trends RSS returned invalid XML',
    });
    const unavailable = sourceWith(['https://example.com/feed.xml'], vi.fn()
      .mockResolvedValue(xmlResponse('private body', { status: 500 })) as typeof fetch);
    await expect(unavailable.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_UNAVAILABLE', message: 'Google Trends RSS is temporarily unavailable',
    });
  });

  it('rejects unsafe initial and redirect targets before requesting them', async () => {
    const initialRequest = vi.fn();
    const unsafeInitial = sourceWith(['https://127.0.0.1/feed.xml'], initialRequest as typeof fetch);
    await expect(unsafeInitial.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID',
    });
    expect(initialRequest).not.toHaveBeenCalled();

    const redirectRequest = vi.fn().mockResolvedValue(new Response('', {
      status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' },
    }));
    const unsafeRedirect = sourceWith(['https://example.com/feed.xml'], redirectRequest as typeof fetch);
    await expect(unsafeRedirect.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID',
    });
    expect(redirectRequest).toHaveBeenCalledOnce();

    const downgradeResponse = new Response('', {
      status: 302,
      headers: { location: 'http://example.com/feed.xml' },
    });
    const cancel = vi.spyOn(downgradeResponse.body!, 'cancel');
    const downgradeRequest = vi.fn().mockResolvedValue(downgradeResponse);
    const downgrade = sourceWith(['https://example.com/feed.xml'], downgradeRequest as typeof fetch);
    await expect(downgrade.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID',
    });
    expect(downgradeRequest).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects oversized XML and maps 429 without exposing response bodies', async () => {
    const oversized = sourceWith(
      ['https://example.com/feed.xml'],
      vi.fn().mockResolvedValue(xmlResponse('<rss><channel><item>oversized</item></channel></rss>')) as typeof fetch,
      { maxBytes: 10 },
    );
    await expect(oversized.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID', message: 'Google Trends RSS returned an invalid response',
    });

    const rateLimited = sourceWith(
      ['https://example.com/feed.xml'],
      vi.fn().mockResolvedValue(xmlResponse('private rate body', { status: 429 })) as typeof fetch,
    );
    let error: unknown;
    try { await rateLimited.collect(window, new AbortController().signal); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'TREND_SOURCE_RATE_LIMITED', retryable: true });
    expect(String(error)).not.toContain('private rate body');
  });
});
