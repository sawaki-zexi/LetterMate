import { describe, expect, it, vi } from 'vitest';
import type { SourceQueryPlan } from './types.js';
import { buildKeywordPolicy } from '../keyword-policy.js';
import { BlueskyCreatorConnector } from './bluesky-creator.js';

const did = 'did:plc:creator';
const plan: SourceQueryPlan = {
  matchPolicy: buildKeywordPolicy('Creator'),
  keyword: 'Creator', expandedTerms: [], queries: ['Creator'], sourceTypes: ['social'],
  windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-10T00:00:00.000Z', maxCandidates: 10,
};

const actor = (value: { did: string; handle: string; displayName?: string }) => ({
  did: value.did, handle: value.handle, displayName: value.displayName ?? value.handle,
});

const post = (id: string, author: ReturnType<typeof actor>, text: string, extras: Record<string, unknown> = {}) => ({
  uri: `at://${author.did}/app.bsky.feed.post/${id}`,
  cid: `cid-${id}`,
  author,
  record: { $type: 'app.bsky.feed.post', text, createdAt: '2026-08-08T12:00:00Z' },
  likeCount: 10, repostCount: 2, replyCount: 3, quoteCount: 1,
  ...extras,
});

describe('BlueskyCreatorConnector', () => {
  it('syncs originals, reposts, quotes, and replies with original context', async () => {
    const creator = actor({ did, handle: 'creator.bsky.social', displayName: 'Creator' });
    const original = post('original', creator, 'Original technical release.');
    const reposted = post('reposted', actor({ did: 'did:plc:source', handle: 'source.bsky.social', displayName: 'Source' }), 'Source post.');
    const quoted = post('quoted', creator, 'My analysis.', {
      embed: { '$type': 'app.bsky.embed.record#view', record: {
        uri: 'at://did:plc:source/app.bsky.feed.post/source-quote',
        author: actor({ did: 'did:plc:source', handle: 'source.bsky.social', displayName: 'Source' }),
        value: { '$type': 'app.bsky.feed.post', text: 'Quoted source context.', createdAt: '2026-08-07T12:00:00Z' },
      } },
    });
    const parent = {
      uri: 'at://did:plc:parent/app.bsky.feed.post/parent',
      author: actor({ did: 'did:plc:parent', handle: 'parent.bsky.social', displayName: 'Parent' }),
      value: { '$type': 'app.bsky.feed.post', text: 'Parent context.', createdAt: '2026-08-07T11:00:00Z' },
    };
    const replyContext = { parent, root: parent };
    const reply = post('reply', creator, 'My substantive reply.', {
      record: {
        '$type': 'app.bsky.feed.post', text: 'My substantive reply.', createdAt: '2026-08-08T12:00:00Z',
        reply: { parent: parent.uri, root: parent.uri },
      },
      reply: replyContext,
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(creator), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feed: [
        { post: original },
        { post: reposted, reason: { '$type': 'app.bsky.feed.defs#reasonRepost', by: creator } },
        { post: quoted },
        { post: reply, reply: replyContext },
      ], cursor: null }), { status: 200 }));
    const connector = new BlueskyCreatorConnector({ did }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    expect(result).toMatchObject({ requestCount: 2, identity: {
      displayName: 'Creator', profileUrl: 'https://bsky.app/profile/creator.bsky.social', handle: '@creator.bsky.social',
    } });
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: original.uri, creatorContext: expect.objectContaining({ contentType: 'original' }) }),
      expect.objectContaining({
        externalId: reposted.uri, url: 'https://bsky.app/profile/source.bsky.social/post/reposted',
        creatorContext: expect.objectContaining({ contentType: 'repost', originalAuthorHandle: 'source.bsky.social' }),
      }),
      expect.objectContaining({
        externalId: quoted.uri, creatorContext: expect.objectContaining({
          contentType: 'repost', originalContentUrl: 'https://bsky.app/profile/source.bsky.social/post/source-quote',
        }),
      }),
      expect.objectContaining({
        externalId: reply.uri, creatorContext: expect.objectContaining({
          contentType: 'reply', parentContentText: 'Parent context.',
        }),
      }),
    ]));
  });

  it('drops replies whose parent record is unavailable and rejects non-author entries', async () => {
    const creator = actor({ did, handle: 'creator.bsky.social' });
    const reply = post('reply', creator, 'Reply without context.', {
      record: {
        '$type': 'app.bsky.feed.post', text: 'Reply without context.', createdAt: '2026-08-08T12:00:00Z',
        reply: { parent: 'at://did:plc:missing/app.bsky.feed.post/parent', root: 'at://did:plc:missing/app.bsky.feed.post/parent' },
      },
    });
    const other = post('other', actor({ did: 'did:plc:other', handle: 'other.bsky.social' }), 'Other post.');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(creator), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feed: [
        { post: reply, reply: { parent: { '$type': 'app.bsky.feed.defs#notFoundPost' } } },
        { post: other },
      ] }), { status: 200 }));
    const result = await new BlueskyCreatorConnector({ did }, fetcher as typeof fetch)
      .search(plan, new AbortController().signal);
    expect(result.candidates).toEqual([]);
  });
});
