import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { HackerNewsConnector } from './hacker-news.js';

const plan: SourceQueryPlan = {
  matchPolicy: buildKeywordPolicy('AI agents'),
  keyword: 'AI agents', expandedTerms: [], queries: ['AI agents'], sourceTypes: ['community'],
  windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z', maxCandidates: 5,
};

describe('HackerNewsConnector', () => {
  it('requests recent stories and normalizes their discussion records', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ hits: [{
      objectID: '123', title: 'Agent runtime release', story_text: 'Detailed implementation notes.',
      author: 'alice', created_at: '2026-07-25T12:00:00.000Z', url: 'https://example.com/release',
    }] }), { status: 200 }));
    const connector = new HackerNewsConnector(fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    const request = new URL(String(fetcher.mock.calls[0]![0]));
    expect(request.origin + request.pathname).toBe('https://hn.algolia.com/api/v1/search_by_date');
    expect(request.searchParams.get('query')).toBe('AI agents');
    expect(request.searchParams.get('tags')).toBe('story');
    expect(request.searchParams.get('numericFilters')).toBe('created_at_i>1784505600');
    expect(result).toMatchObject({ requestCount: 1, candidates: [expect.objectContaining({
      connectorId: 'hacker-news', sourceType: 'community', platform: 'Hacker News', externalId: '123',
      url: 'https://news.ycombinator.com/item?id=123', authorHandle: 'alice',
      content: expect.stringContaining('Detailed implementation notes.'),
      proof: { kind: 'api_record', connectorId: 'hacker-news', externalId: '123' },
    })] });
  });

  it('returns a safe response error for malformed Algolia data', async () => {
    const connector = new HackerNewsConnector(
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ hits: 'nope' }), { status: 200 })) as unknown as typeof fetch,
    );
    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_RESPONSE_INVALID', retryable: false,
    });
  });
});
