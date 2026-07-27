import { describe, expect, it, vi } from 'vitest';
import type { SourceQueryPlan } from './types.js';
import { BlueskyConnector } from './bluesky.js';

const plan: SourceQueryPlan = {
  keyword: 'agent runtime', expandedTerms: [], queries: ['agent runtime'], sourceTypes: ['social'],
  windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z', maxCandidates: 5,
};
const post = {
  uri: 'at://did:plc:project/app.bsky.feed.post/abc', cid: 'cid-1',
  author: { did: 'did:plc:project', handle: 'project.bsky.social', displayName: 'Project' },
  record: { $type: 'app.bsky.feed.post', text: 'We released durable checkpoint recovery.', createdAt: '2026-07-25T12:00:00Z' },
  likeCount: 10, repostCount: 2, replyCount: 3, quoteCount: 1,
  embed: { $type: 'app.bsky.embed.record#view', record: {
    uri: 'at://did:plc:author/app.bsky.feed.post/quoted',
    author: { did: 'did:plc:author', handle: 'author.bsky.social', displayName: 'Author' },
    value: { $type: 'app.bsky.feed.post', text: 'Original technical context.', createdAt: '2026-07-24T11:00:00Z' },
  } },
};

describe('BlueskyConnector', () => {
  it('normalizes public AppView posts and quoted context', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ posts: [post] }), { status: 200 }));
    const connector = new BlueskyConnector(fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts');
    expect(url.searchParams.get('q')).toBe('agent runtime');
    expect(result).toMatchObject({ requestCount: 1, candidates: [expect.objectContaining({
      connectorId: 'bluesky', sourceType: 'social', platform: 'Bluesky', externalId: post.uri,
      url: 'https://bsky.app/profile/project.bsky.social/post/abc', authorName: 'Project',
      authorHandle: 'project.bsky.social', publishedAt: '2026-07-25T12:00:00.000Z',
      content: 'We released durable checkpoint recovery.\n\nQuoted post: Original technical context.',
      engagement: { likes: 10, reposts: 2, replies: 3, quotes: 1 },
      proof: { kind: 'api_record', connectorId: 'bluesky', externalId: post.uri },
    })] });
  });

  it('returns a safe response error for invalid AT URIs', async () => {
    const connector = new BlueskyConnector(vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ posts: [{ ...post, uri: 'not-an-at-uri' }] }), { status: 200 }),
    ) as unknown as typeof fetch);
    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_RESPONSE_INVALID', retryable: false,
    });
  });
});
