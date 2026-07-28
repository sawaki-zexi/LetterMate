import { describe, expect, it, vi } from 'vitest';
import { RedditTrendSource } from './reddit.js';
import type { TrendWindow } from './types.js';

const window: TrendWindow = {
  windowStart: '2026-07-27T00:00:00.000Z', windowEnd: '2026-07-28T00:00:00.000Z',
  maxCandidates: 10, requestBudget: 3,
};

const listing = (community: string, id: string) => new Response(JSON.stringify({ data: { children: [{ kind: 't3', data: {
  id, name: `t3_${id}`, title: `${community} hot post`,
  permalink: `/r/${community}/comments/${id}/hot_post/`, created_utc: 1785196800,
  score: 999,
} }] } }), { status: 200 });

describe('RedditTrendSource', () => {
  it('uses transient OAuth and collects configured community hot seeds within budget', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'temporary-token', token_type: 'bearer', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(listing('programming', 'abc'))
      .mockResolvedValueOnce(listing('technology', 'def'));
    const signal = new AbortController().signal;
    const source = new RedditTrendSource({
      clientId: 'client-id', clientSecret: 'client-secret', communities: ['programming', 'technology', 'ignored'], limit: 25,
    }, fetcher as typeof fetch);

    const result = await source.collect(window, signal);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]).toEqual(['https://www.reddit.com/api/v1/access_token', {
      method: 'POST', body: 'grant_type=client_credentials', redirect: 'error', signal,
      headers: {
        authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'LetterMate/0.1',
      },
    }]);
    expect(fetcher.mock.calls.slice(1).map(([rawUrl, init]) => ({
      url: String(rawUrl), authorization: init.headers.authorization, redirect: init.redirect, signal: init.signal,
    }))).toEqual([
      { url: 'https://oauth.reddit.com/r/programming/hot?limit=25&raw_json=1', authorization: 'Bearer temporary-token', redirect: 'error', signal },
      { url: 'https://oauth.reddit.com/r/technology/hot?limit=25&raw_json=1', authorization: 'Bearer temporary-token', redirect: 'error', signal },
    ]);
    expect(result).toEqual({ requestCount: 3, candidates: [
      { sourceId: 'reddit-trends', platform: 'Reddit', externalId: 't3_abc', title: 'programming hot post', url: 'https://www.reddit.com/r/programming/comments/abc/hot_post/', publishedAt: '2026-07-28T00:00:00.000Z' },
      { sourceId: 'reddit-trends', platform: 'Reddit', externalId: 't3_def', title: 'technology hot post', url: 'https://www.reddit.com/r/technology/comments/def/hot_post/', publishedAt: '2026-07-28T00:00:00.000Z' },
    ] });
    expect(JSON.stringify(result)).not.toContain('temporary-token');
    expect(JSON.stringify(result)).not.toContain('score');
  });

  it('requires both credentials and validates configured community names', () => {
    expect(new RedditTrendSource({ clientId: 'id', clientSecret: undefined, communities: ['programming'] }).isEnabled()).toBe(false);
    expect(() => new RedditTrendSource({ clientId: 'id', clientSecret: 'secret', communities: ['r/programming'] })).toThrow('communities');
  });

  it('does not acquire a token when the request budget cannot reach a listing', async () => {
    const fetcher = vi.fn();
    const result = await new RedditTrendSource({ clientId: 'id', clientSecret: 'secret', communities: ['programming'] }, fetcher as typeof fetch)
      .collect({ ...window, requestBudget: 1 }, new AbortController().signal);
    expect(result).toEqual({ candidates: [], requestCount: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts normal t3 listing children while projecting only seed fields', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'token', token_type: 'bearer', expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: 'Listing',
        data: {
          after: null,
          children: [{
            kind: 't1',
            data: { body: 'unsupported comment child' },
          }, {
            kind: 't3',
            data: {
              id: 'realpost', name: 't3_realpost', title: 'A realistic Reddit listing post',
              permalink: '/r/programming/comments/realpost/a_realistic_post/',
              created_utc: 1785196800, author: 'upstream-author', score: 999,
              selftext: 'untrusted upstream payload', subreddit: 'programming', over_18: false,
            },
          }],
        },
      }), { status: 200 }));

    const result = await new RedditTrendSource({
      clientId: 'id', clientSecret: 'secret', communities: ['programming'],
    }, fetcher as typeof fetch).collect(window, new AbortController().signal);

    expect(result).toEqual({ requestCount: 2, candidates: [{
      sourceId: 'reddit-trends', platform: 'Reddit', externalId: 't3_realpost',
      title: 'A realistic Reddit listing post',
      url: 'https://www.reddit.com/r/programming/comments/realpost/a_realistic_post/',
      publishedAt: '2026-07-28T00:00:00.000Z',
    }] });
    expect(JSON.stringify(result)).not.toContain('upstream-author');
    expect(JSON.stringify(result)).not.toContain('selftext');
  });

  it('rejects a permalink outside the configured community', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', token_type: 'bearer', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(listing('not-programming', 'abc'));
    const result = await new RedditTrendSource({
      clientId: 'id', clientSecret: 'secret', communities: ['programming'],
    }, fetcher as typeof fetch).collect(window, new AbortController().signal);

    expect(result).toEqual({ candidates: [], requestCount: 2 });
  });

  it('sanitizes OAuth and listing failures', async () => {
    const response = new Response('private token body', { status: 401 });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const source = new RedditTrendSource({ clientId: 'private-id', clientSecret: 'private-secret', communities: ['programming'] }, vi.fn()
      .mockResolvedValue(response) as typeof fetch);
    let error: unknown;
    try { await source.collect(window, new AbortController().signal); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'TREND_SOURCE_AUTH_FAILED', message: 'Reddit credentials are unavailable' });
    expect(String(error)).not.toContain('private');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects an oversized OAuth JSON response before parsing it', async () => {
    const token = { access_token: 'private-token', token_type: 'bearer', expires_in: 3600 };
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(token), { headers: { 'content-length': '600000' } }),
    );
    const source = new RedditTrendSource({ clientId: 'id', clientSecret: 'secret', communities: ['programming'] }, fetcher as typeof fetch);
    await expect(source.collect(window, new AbortController().signal)).rejects.toMatchObject({
      code: 'TREND_SOURCE_RESPONSE_INVALID', message: 'Reddit returned an invalid response',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('skips extreme dates and overlong fields while keeping a valid sibling', async () => {
    const post = (overrides: Record<string, unknown>) => ({
      kind: 't3',
      data: {
        id: 'post', name: 't3_post', title: 'Post',
        permalink: '/r/programming/comments/post/post/', created_utc: 1785196800,
        ...overrides,
      },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', token_type: 'bearer', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { children: [
        post({ id: 'extreme', name: 't3_extreme', created_utc: Number.MAX_SAFE_INTEGER }),
        post({ id: 'long', name: `t3_${'x'.repeat(501)}`, title: 'x'.repeat(501) }),
        post({ id: 'valid', name: 't3_valid', title: 'Valid sibling', permalink: '/r/programming/comments/valid/valid/' }),
      ] } }), { status: 200 }));

    const result = await new RedditTrendSource({
      clientId: 'id', clientSecret: 'secret', communities: ['programming'],
    }, fetcher as typeof fetch).collect(window, new AbortController().signal);

    expect(result.candidates).toEqual([{
      sourceId: 'reddit-trends', platform: 'Reddit', externalId: 't3_valid',
      title: 'Valid sibling', url: 'https://www.reddit.com/r/programming/comments/valid/valid/',
      publishedAt: '2026-07-28T00:00:00.000Z',
    }]);
  });
});
