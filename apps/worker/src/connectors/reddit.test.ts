import { describe, expect, it, vi } from 'vitest';
import type { SourceQueryPlan } from './types.js';
import { RedditConnector } from './reddit.js';

const plan: SourceQueryPlan = {
  keyword: 'agent runtime', expandedTerms: [], queries: ['agent runtime'], sourceTypes: ['community'],
  windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z', maxCandidates: 5,
};

describe('RedditConnector', () => {
  it('uses client credentials and normalizes substantive posts', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token', token_type: 'bearer', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { children: [{ data: {
        id: 'abc', name: 't3_abc', title: 'Agent runtime field report', selftext: 'Detailed operational lessons.',
        permalink: '/r/agents/comments/abc/report/', url: 'https://example.com/report', author: 'alice',
        created_utc: 1784980800, score: 42, num_comments: 7,
      } }] } }), { status: 200 }));
    const connector = new RedditConnector({ clientId: 'client-id', clientSecret: 'client-secret' }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    expect(String(fetcher.mock.calls[0]![0])).toBe('https://www.reddit.com/api/v1/access_token');
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toHaveProperty(
      'authorization', `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    );
    const search = new URL(String(fetcher.mock.calls[1]![0]));
    expect(search.origin + search.pathname).toBe('https://oauth.reddit.com/search');
    expect((fetcher.mock.calls[1]![1] as RequestInit).headers).toHaveProperty('authorization', 'Bearer access-token');
    expect(result).toMatchObject({ requestCount: 2, candidates: [expect.objectContaining({
      connectorId: 'reddit', sourceType: 'community', platform: 'Reddit', externalId: 't3_abc',
      url: 'https://www.reddit.com/r/agents/comments/abc/report/', authorHandle: 'alice',
      content: 'Detailed operational lessons.\n\nhttps://example.com/report', engagement: { score: 42, comments: 7 },
      proof: { kind: 'api_record', connectorId: 'reddit', externalId: 't3_abc' },
    })] });
  });

  it('is disabled without both credentials and never exposes them in errors', async () => {
    expect(new RedditConnector({ clientId: 'id' }).isEnabled()).toBe(false);
    const connector = new RedditConnector({ clientId: 'id', clientSecret: 'secret' }, vi.fn().mockResolvedValue(
      new Response('{"error":"secret"}', { status: 401 }),
    ) as unknown as typeof fetch);
    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_AUTH_FAILED', retryable: false,
    });
    await expect(connector.search(plan, new AbortController().signal)).rejects.not.toThrow(/secret/);
  });
});
