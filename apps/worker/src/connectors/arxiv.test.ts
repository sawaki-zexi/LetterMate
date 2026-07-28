import { describe, expect, it, vi } from 'vitest';
import type { SourceQueryPlan } from './types.js';
import { ArxivConnector } from './arxiv.js';

const plan: SourceQueryPlan = {
  keyword: 'agent planning', expandedTerms: [], queries: ['agent planning'], sourceTypes: ['paper'],
  windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z', maxCandidates: 5,
};

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/2607.12345v1</id><updated>2026-07-25T12:00:00Z</updated><published>2026-07-24T10:00:00Z</published>
<title> Agent Planning with Durable Memory </title><summary> A substantive abstract about planning systems. </summary>
<author><name>Ada Lovelace</name></author><author><name>Grace Hopper</name></author>
<link href="http://arxiv.org/abs/2607.12345v1" rel="alternate" type="text/html"/><link href="http://arxiv.org/pdf/2607.12345v1" rel="related" type="application/pdf"/></entry></feed>`;

describe('ArxivConnector', () => {
  it('queries the Atom API and normalizes paper metadata', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(atom, { status: 200 }));
    const result = await new ArxivConnector(fetcher as typeof fetch).search(plan, new AbortController().signal);

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
    expect(url.searchParams.get('search_query')).toBe('all:"agent planning"');
    expect(url.searchParams.get('max_results')).toBe('5');
    expect(result).toMatchObject({ requestCount: 1, candidates: [expect.objectContaining({
      connectorId: 'arxiv', sourceType: 'paper', platform: 'arXiv', externalId: '2607.12345v1',
      url: 'https://arxiv.org/abs/2607.12345v1', title: 'Agent Planning with Durable Memory',
      content: 'A substantive abstract about planning systems.\n\nPDF: https://arxiv.org/pdf/2607.12345v1',
      authorName: 'Ada Lovelace, Grace Hopper', publishedAt: '2026-07-24T10:00:00.000Z',
      proof: {
        kind: 'feed_entry', connectorId: 'arxiv', entryId: '2607.12345v1',
        feedUrl: 'https://export.arxiv.org/api/query?search_query=all%3A%22agent+planning%22&start=0&max_results=5',
      },
    })] });
  });

  it('returns a safe response error for invalid Atom entries', async () => {
    const connector = new ArxivConnector(vi.fn().mockResolvedValue(
      new Response('<feed><entry><id>not-a-paper</id></entry></feed>', { status: 200 }),
    ) as unknown as typeof fetch);
    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_RESPONSE_INVALID', retryable: false,
    });
  });
});
