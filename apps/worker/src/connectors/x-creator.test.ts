import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { XCreatorConnector } from './x-creator.js';

const plan: SourceQueryPlan = {
  keyword: 'Example Creator',
  matchPolicy: buildKeywordPolicy('Example Creator'),
  expandedTerms: [],
  queries: ['Example Creator'],
  sourceTypes: ['social'],
  windowStart: '2026-08-01T00:00:00.000Z',
  windowEnd: '2026-08-08T00:00:00.000Z',
  maxCandidates: 30,
};

const tweet = (overrides: Record<string, unknown> = {}) => ({
  id: '100',
  text: 'A detailed public update with enough substance to evaluate independently.',
  createdAt: '2026-08-07T08:00:00.000Z',
  lang: 'en',
  likeCount: 30,
  retweetCount: 5,
  replyCount: 2,
  quoteCount: 1,
  viewCount: 500,
  isReply: false,
  author: { id: 'creator-id', name: 'Example Creator', userName: 'example' },
  entities: { urls: [] },
  ...overrides,
});

describe('XCreatorConnector', () => {
  it('loads a stable user timeline and preserves repost and reply relationships', async () => {
    const original = tweet({
      id: '200',
      text: 'Original research release with implementation details.',
      author: { id: 'other-id', name: 'Original Author', userName: 'original' },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tweets: [
          tweet(),
          tweet({ id: '201', text: 'RT', retweeted_tweet: original }),
          tweet({
            id: '300',
            text: '@parent This reply explains the tradeoffs, migration path, and concrete implementation constraints in detail.',
            isReply: true,
            inReplyToId: '250',
          }),
          tweet({ id: '301', text: '@parent thanks', isReply: true, inReplyToId: '250', likeCount: 0 }),
        ],
        has_next_page: false,
        next_cursor: null,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tweets: [tweet({
          id: '250',
          text: 'The parent post establishes the original technical question.',
          author: { id: 'parent-id', name: 'Parent Author', userName: 'parent' },
        })],
      }), { status: 200 }));
    const connector = new XCreatorConnector(
      { apiKey: 'test-key', userId: 'creator-id', pageBudget: 1 },
      fetcher as typeof fetch,
    );

    const result = await connector.search(plan, new AbortController().signal);

    expect(result.requestCount).toBe(2);
    expect(result.identity).toEqual({
      displayName: 'Example Creator',
      profileUrl: 'https://x.com/example',
      handle: '@example',
    });
    const timelineUrl = new URL(String(fetcher.mock.calls[0]![0]));
    expect(timelineUrl.pathname).toBe('/twitter/user/tweet_timeline');
    expect(timelineUrl.searchParams.get('userId')).toBe('creator-id');
    expect(timelineUrl.searchParams.get('includeReplies')).toBe('true');
    expect(timelineUrl.searchParams.get('includeParentTweet')).toBe('true');
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[1]).toMatchObject({
      externalId: '201',
      authorName: 'Original Author',
      authorHandle: 'original',
      creatorContext: {
        contentType: 'repost',
        originalAuthorName: 'Original Author',
        originalAuthorHandle: 'original',
        originalContentId: '200',
      },
    });
    expect(result.candidates[2]).toMatchObject({
      externalId: '300',
      creatorContext: {
        contentType: 'reply',
        parentContentId: '250',
        parentContentUrl: 'https://x.com/parent/status/250',
        parentContentText: 'The parent post establishes the original technical question.',
      },
    });
    expect(result.candidates[2]!.content).toContain('原帖：The parent post');
  });

  it('fails safely when X is not configured', async () => {
    const connector = new XCreatorConnector({ apiKey: undefined, userId: 'creator-id' });
    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_NOT_CONFIGURED',
    });
  });

  it('folds same-author thread context into the root post', async () => {
    const root = tweet({
      id: '400',
      text: 'Thread: a complete migration guide for the new runtime.',
      conversationId: '400',
      isThread: true,
    });
    const child = tweet({
      id: '401',
      text: 'The second post covers rollback behavior and compatibility constraints.',
      conversationId: '400',
      isReply: true,
      inReplyToId: '400',
      createdAt: '2026-08-07T08:01:00.000Z',
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tweets: [root, child], has_next_page: false, next_cursor: null,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tweets: [root] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tweets: [root, child], has_next_page: false, next_cursor: null,
      }), { status: 200 }));
    const connector = new XCreatorConnector(
      { apiKey: 'test-key', userId: 'creator-id', pageBudget: 1 },
      fetcher as typeof fetch,
    );

    const result = await connector.search(plan, new AbortController().signal);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ externalId: '400' });
    expect(result.candidates[0]!.content).toContain('rollback behavior and compatibility constraints');
    expect(new URL(String(fetcher.mock.calls[2]![0])).pathname).toBe('/twitter/tweet/thread_context');
  });
});
