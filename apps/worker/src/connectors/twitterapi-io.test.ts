import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { ConnectorError } from './types.js';
import { TwitterApiIoConnector } from './twitterapi-io.js';

const plan: SourceQueryPlan = {
  keyword: 'AI agents',
  matchPolicy: buildKeywordPolicy('AI agents'),
  expandedTerms: ['agentic AI'],
  queries: ['AI agents latest'],
  sourceTypes: ['social'],
  windowStart: '2026-07-20T00:00:00.000Z',
  windowEnd: '2026-07-27T00:00:00.000Z',
  maxCandidates: 10,
};

const tweet = (overrides: Record<string, unknown> = {}) => {
  const id = typeof overrides.id === 'string' ? overrides.id : '100';
  return {
  id,
  text: 'We released agent version two with public documentation.',
  createdAt: '2026-07-25T12:00:00.000Z',
  lang: 'en',
  likeCount: 12,
  retweetCount: 3,
  replyCount: 2,
  quoteCount: 1,
  viewCount: 99,
  isRetweet: false,
  isQuote: false,
  isThread: false,
  conversationId: id,
  author: { name: 'Project Team', userName: 'Project' },
  entities: {
    urls: [{ url: 'https://t.co/docs', expanded_url: 'https://example.com/docs' }],
  },
  ...overrides,
  };
};

const searchResponse = (tweets: unknown[], nextCursor?: string) => new Response(
  JSON.stringify({
    tweets,
    has_next_page: nextCursor !== undefined,
    next_cursor: nextCursor,
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

const threadResponse = (replies: unknown[], nextCursor?: string) => new Response(
  JSON.stringify({
    replies,
    has_next_page: nextCursor !== undefined,
    next_cursor: nextCursor,
    status: 'success',
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

const makeConnector = (
  fetcher: typeof fetch,
  options: Partial<{ pageBudget: number; threadBudget: number }> = {},
) => new TwitterApiIoConnector({
  apiKey: 'test-twitter-key',
  pageBudget: 1,
  threadBudget: 2,
  ...options,
}, fetcher);

describe('TwitterApiIoConnector', () => {
  it('is disabled without a key and only supports social discovery plans', () => {
    const connector = new TwitterApiIoConnector({ apiKey: undefined });

    expect(connector.isEnabled()).toBe(false);
    expect(connector.supports(plan)).toBe(true);
    expect(connector.supports({ ...plan, sourceTypes: ['web'] })).toBe(false);
  });

  it('searches Latest and Top in the requested Unix time window and normalizes X candidates', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        tweet(),
        tweet({
          id: '200',
          isRetweet: undefined,
          retweeted_tweet: tweet({ id: '100' }),
        }),
        tweet({
          id: '300',
          text: 'This adds context to the quoted launch.',
          isQuote: undefined,
          quoted_tweet: tweet({ id: '250', text: 'The original launch details.' }),
        }),
      ]))
      .mockResolvedValueOnce(searchResponse([tweet()]));

    const result = await makeConnector(fetcher as typeof fetch).search(plan, new AbortController().signal);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const requests = fetcher.mock.calls.map(([url, init]) => ({ url: String(url), init }));
    expect(requests[0]).toMatchObject({
      url: expect.stringContaining('/twitter/tweet/advanced_search'),
      init: { headers: { 'x-api-key': 'test-twitter-key' } },
    });
    expect(new URL(requests[0]!.url).searchParams.get('queryType')).toBe('Latest');
    expect(new URL(requests[1]!.url).searchParams.get('queryType')).toBe('Top');
    expect(new URL(requests[0]!.url).searchParams.get('query'))
      .toBe('AI agents latest since_time:1784505600 until_time:1785110400');
    expect(new URL(requests[0]!.url).searchParams.get('since_time')).toBeNull();
    expect(result.requestCount).toBe(2);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      connectorId: 'twitterapi-io',
      sourceType: 'social',
      platform: 'X',
      externalId: '100',
      url: 'https://x.com/project/status/100',
      authorName: 'Project Team',
      authorHandle: 'project',
      publishedAt: '2026-07-25T12:00:00.000Z',
      engagement: { likes: 12, reposts: 3, replies: 2, quotes: 1, views: 99 },
      proof: { kind: 'api_record', connectorId: 'twitterapi-io', externalId: '100' },
    });
    expect(result.candidates[0]!.content).toContain('https://example.com/docs');
    expect(result.candidates[1]).toMatchObject({ externalId: '300' });
    expect(result.candidates[1]!.content).toContain('Quoted post: The original launch details.');
  });

  it('uses the configured cursor page budget for each query type', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(searchResponse([tweet()], 'latest-page-2'))
      .mockResolvedValueOnce(searchResponse([tweet({ id: '101' })], 'latest-page-3'))
      .mockResolvedValueOnce(searchResponse([tweet({ id: '102' })], 'top-page-2'))
      .mockResolvedValueOnce(searchResponse([tweet({ id: '103' })], 'top-page-3'));

    await makeConnector(fetcher as typeof fetch, { pageBudget: 2 }).search(
      plan,
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('cursor')))
      .toEqual([null, 'latest-page-2', null, 'top-page-2']);
  });

  it('enriches shortlisted original threads across cursor pages within the page budget', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(searchResponse([tweet({
        id: '400',
        isThread: undefined,
        text: 'Thread: our agent runtime now supports reliable checkpoints.',
      })]))
      .mockResolvedValueOnce(searchResponse([tweet({
        id: '400',
        isThread: undefined,
        text: 'Thread: our agent runtime now supports reliable checkpoints.',
      })]))
      .mockResolvedValueOnce(threadResponse([
        tweet({ id: '401', text: 'Second update explains checkpoint recovery.', createdAt: '2026-07-25T12:01:00.000Z' }),
        tweet({ id: '999', text: 'Unrelated reply', author: { name: 'Other', userName: 'other' } }),
      ], 'thread-page-2'))
      .mockResolvedValueOnce(threadResponse([
        tweet({ id: '402', text: 'Third update with the migration guide.', createdAt: '2026-07-25T12:02:00.000Z' }),
      ]));

    const result = await makeConnector(fetcher as typeof fetch, { pageBudget: 2 }).search(
      plan,
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledTimes(4);
    const threadUrl = String(fetcher.mock.calls[2]![0]);
    expect(threadUrl).toContain('/twitter/tweet/thread_context');
    expect(new URL(threadUrl).searchParams.get('tweetId')).toBe('400');
    expect(new URL(String(fetcher.mock.calls[3]![0])).searchParams.get('cursor'))
      .toBe('thread-page-2');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.content).toContain('Second update explains checkpoint recovery.');
    expect(result.candidates[0]!.content).toContain('Third update with the migration guide.');
    expect(result.candidates[0]!.content).not.toContain('Unrelated reply');
  });

  it('maps upstream failures to safe connector errors without exposing the API key', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'key test-twitter-key rejected' }), { status: 401 }),
    );

    await expect(makeConnector(fetcher as typeof fetch).search(plan, new AbortController().signal))
      .rejects.toMatchObject({ code: 'CONNECTOR_AUTH_FAILED', retryable: false });
    try {
      await makeConnector(fetcher as typeof fetch).search(plan, new AbortController().signal);
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as Error).message).not.toContain('test-twitter-key');
    }
  });

  it('rejects malformed thread replies as safe response errors', async () => {
    const root = tweet({
      id: '500',
      text: 'Thread: a documented migration sequence for agent runtime users.',
      isThread: undefined,
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(searchResponse([root]))
      .mockResolvedValueOnce(searchResponse([root]))
      .mockResolvedValueOnce(threadResponse([{ id: 'broken reply' }]));

    await expect(makeConnector(fetcher as typeof fetch).search(plan, new AbortController().signal))
      .rejects.toMatchObject({ code: 'CONNECTOR_RESPONSE_INVALID', retryable: false });
  });

  it('rejects malformed provider payloads as safe response errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tweets: 'not an array' }), { status: 200 }),
    );

    await expect(makeConnector(fetcher as typeof fetch).search(plan, new AbortController().signal))
      .rejects.toMatchObject({ code: 'CONNECTOR_RESPONSE_INVALID', retryable: false });
  });
});
