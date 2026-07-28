import { z } from 'zod';
import { readBoundedJson } from './http.js';
import { TrendSourceError, type TrendSeedCandidate, type TrendSource, type TrendSourceResult, type TrendWindow } from './types.js';

const tokenSchema = z.object({
  access_token: z.string().min(1), token_type: z.string().min(1), expires_in: z.number().finite().positive(),
});
const listingChildSchema = z.object({
  kind: z.string().min(1),
  data: z.unknown(),
});
const listingSchema = z.object({
  data: z.object({ children: z.array(listingChildSchema).max(100) }),
});
const postSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), title: z.string(), permalink: z.string().startsWith('/'),
  created_utc: z.number().finite().nonnegative(),
});

export interface RedditTrendSourceConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  communities: string[];
  limit?: number;
}

export class RedditTrendSource implements TrendSource {
  readonly id = 'reddit-trends';
  readonly label = 'Reddit';
  readonly minimumRequestBudget = 2;
  private readonly communities: string[];
  private readonly limit: number;

  constructor(private readonly config: RedditTrendSourceConfig, private readonly fetcher: typeof fetch = fetch) {
    if (config.communities.some((community) => !/^[A-Za-z0-9_-]+$/.test(community))) {
      throw new Error('communities must contain Reddit community names only');
    }
    this.communities = [...config.communities];
    this.limit = config.limit ?? 30;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 100) throw new Error('limit must be an integer from 1 to 100');
  }

  isEnabled(): boolean {
    return Boolean(this.config.clientId?.trim() && this.config.clientSecret?.trim() && this.communities.length > 0);
  }

  async collect(window: TrendWindow, signal: AbortSignal): Promise<TrendSourceResult> {
    if (window.requestBudget < 2 || window.maxCandidates === 0 || this.communities.length === 0) {
      return { candidates: [], requestCount: 0 };
    }
    const clientId = this.config.clientId?.trim();
    const clientSecret = this.config.clientSecret?.trim();
    if (!clientId || !clientSecret) throw new TrendSourceError('TREND_SOURCE_NOT_CONFIGURED', 'Reddit is not configured', false);
    window.recordRequest?.();
    const tokenPayload = await this.request('https://www.reddit.com/api/v1/access_token', {
      method: 'POST', body: 'grant_type=client_credentials', signal,
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'LetterMate/0.1',
      },
    });
    const token = tokenSchema.safeParse(tokenPayload);
    if (!token.success) throw this.invalid();
    let requestCount = 1;
    const candidates: TrendSeedCandidate[] = [];
    for (const community of this.communities.slice(0, window.requestBudget - 1)) {
      const url = new URL(`https://oauth.reddit.com/r/${community}/hot`);
      url.searchParams.set('limit', String(this.limit));
      url.searchParams.set('raw_json', '1');
      window.recordRequest?.();
      const payload = await this.request(url.toString(), {
        signal,
        headers: { authorization: `Bearer ${token.data.access_token}`, 'user-agent': 'LetterMate/0.1' },
      });
      requestCount += 1;
      const listing = listingSchema.safeParse(payload);
      if (!listing.success) throw this.invalid();
      for (const child of listing.data.data.children) {
        if (child.kind !== 't3') continue;
        const parsed = postSchema.safeParse(child.data);
        if (!parsed.success) continue;
        const post = parsed.data;
        const title = post.title.trim();
        if (!title) continue;
        let permalink: URL;
        try { permalink = new URL(post.permalink, 'https://www.reddit.com'); } catch { continue; }
        if (
          permalink.protocol !== 'https:' ||
          permalink.hostname !== 'www.reddit.com' ||
          !permalink.pathname.toLowerCase().startsWith(`/r/${community.toLowerCase()}/`)
        ) continue;
        candidates.push({
          sourceId: this.id,
          platform: this.label,
          externalId: post.name,
          title,
          url: permalink.toString(),
          publishedAt: new Date(post.created_utc * 1_000).toISOString(),
        });
        if (candidates.length >= window.maxCandidates) break;
      }
      if (candidates.length >= window.maxCandidates) break;
    }
    return { candidates, requestCount };
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try { response = await this.fetcher(url, init); }
    catch {
      if (init.signal?.aborted) throw new TrendSourceError('TREND_SOURCE_ABORTED', 'Reddit collection was aborted', true);
      throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'Reddit is temporarily unavailable', true);
    }
    if (response.status === 401 || response.status === 403) throw new TrendSourceError('TREND_SOURCE_AUTH_FAILED', 'Reddit credentials are unavailable', false);
    if (response.status === 429) throw new TrendSourceError('TREND_SOURCE_RATE_LIMITED', 'Reddit rate limit reached', true);
    if (!response.ok) throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'Reddit is temporarily unavailable', response.status >= 500);
    try { return await readBoundedJson(response); } catch { throw this.invalid(); }
  }

  private invalid(): TrendSourceError {
    return new TrendSourceError('TREND_SOURCE_RESPONSE_INVALID', 'Reddit returned an invalid response', false);
  }
}
