import { describe, expect, it, vi } from 'vitest';
import type { SourceQueryPlan } from './types.js';
import { RssConnector } from './rss.js';

const plan: SourceQueryPlan = {
  keyword: 'AI agents',
  expandedTerms: [],
  queries: ['AI agents'],
  sourceTypes: ['feed'],
  windowStart: '2026-07-20T00:00:00.000Z',
  windowEnd: '2026-07-27T00:00:00.000Z',
  maxCandidates: 10,
};

const rssFeed = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Engineering Blog</title><link>https://example.com</link>
<item><guid>release-1</guid><title>Agent runtime release</title><link>https://example.com/releases/1</link>
<description><![CDATA[<p>A <strong>substantive</strong> release note.</p>]]></description>
<author>team@example.com (Project Team)</author><pubDate>Fri, 25 Jul 2026 12:00:00 GMT</pubDate></item>
</channel></rss>`;

const atomFeed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Research</title>
<entry><id>urn:example:paper-1</id><title>Agent planning paper</title>
<link rel="alternate" href="https://example.org/papers/1"/>
<updated>2026-07-24T09:00:00Z</updated><author><name>Research Lab</name></author>
<summary><![CDATA[<p>Abstract with <em>methods</em>.</p>]]></summary></entry></feed>`;

const makeConnector = (feedUrls: string[], fetcher: typeof fetch) => new RssConnector(
  { feedUrls, maxEntriesPerFeed: 5 },
  fetcher,
);

describe('RssConnector', () => {
  it('normalizes RSS 2.0 and Atom entries with feed-entry proofs', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(rssFeed, { status: 200 }))
      .mockResolvedValueOnce(new Response(atomFeed, { status: 200 }));
    const connector = makeConnector(
      ['https://example.com/feed.xml', 'https://example.org/atom.xml'],
      fetcher as typeof fetch,
    );

    const result = await connector.search(plan, new AbortController().signal);

    expect(connector.isEnabled()).toBe(true);
    expect(connector.supports(plan)).toBe(true);
    expect(result.requestCount).toBe(2);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        connectorId: 'rss',
        sourceType: 'feed',
        platform: 'Engineering Blog',
        externalId: 'release-1',
        url: 'https://example.com/releases/1',
        content: 'A substantive release note.',
        authorName: 'Project Team',
        publishedAt: '2026-07-25T12:00:00.000Z',
        proof: {
          kind: 'feed_entry', connectorId: 'rss', feedUrl: 'https://example.com/feed.xml', entryId: 'release-1',
        },
      }),
      expect.objectContaining({
        platform: 'Research',
        externalId: 'urn:example:paper-1',
        url: 'https://example.org/papers/1',
        content: 'Abstract with methods.',
        authorName: 'Research Lab',
        publishedAt: '2026-07-24T09:00:00.000Z',
        proof: {
          kind: 'feed_entry', connectorId: 'rss', feedUrl: 'https://example.org/atom.xml', entryId: 'urn:example:paper-1',
        },
      }),
    ]);
  });

  it('is disabled without feeds and only supports feed discovery plans', () => {
    const connector = makeConnector([], vi.fn() as unknown as typeof fetch);

    expect(connector.isEnabled()).toBe(false);
    expect(connector.supports({ ...plan, sourceTypes: ['web'] })).toBe(false);
  });

  it.each([
    ['malformed XML', '<rss><channel><item></rss>'],
    ['non-HTTP entry link', '<rss><channel><title>Bad</title><item><guid>x</guid><title>x</title><link>javascript:alert(1)</link></item></channel></rss>'],
  ])('returns a safe invalid-response error for %s', async (_label, body) => {
    const connector = makeConnector(
      ['https://example.com/feed.xml'],
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })) as unknown as typeof fetch,
    );

    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_RESPONSE_INVALID', retryable: false,
    });
  });
});
