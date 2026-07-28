import { z } from 'zod';
import { createTrendCandidate } from './candidate.js';
import { readBoundedJson } from './http.js';
import { TrendSourceError, type TrendSeedCandidate, type TrendSource, type TrendSourceResult, type TrendWindow } from './types.js';

const trendSchema = z.object({
  name: z.string(),
  query: z.string().optional().nullable(),
  id: z.union([z.string(), z.number()]).optional().nullable(),
}).passthrough();
const responseSchema = z.object({ trends: z.array(z.unknown()).max(100) }).passthrough();

export interface TwitterApiIoTrendSourceConfig {
  apiKey: string | undefined;
  woeids: number[];
}

export class TwitterApiIoTrendSource implements TrendSource {
  readonly id = 'twitter-trends';
  readonly label = 'X Trends';
  readonly minimumRequestBudget = 1;
  private readonly woeids: number[];

  constructor(
    private readonly config: TwitterApiIoTrendSourceConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (config.woeids.some((woeid) => !Number.isInteger(woeid) || woeid < 1)) {
      throw new Error('woeids must contain positive integers');
    }
    this.woeids = [...config.woeids];
  }

  isEnabled(): boolean { return Boolean(this.config.apiKey?.trim() && this.woeids.length > 0); }

  async collect(window: TrendWindow, signal: AbortSignal): Promise<TrendSourceResult> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new TrendSourceError('TREND_SOURCE_NOT_CONFIGURED', 'TwitterAPI.io is not configured', false);
    if (window.requestBudget === 0 || window.maxCandidates === 0) {
      return { candidates: [], requestCount: 0 };
    }
    const candidates: TrendSeedCandidate[] = [];
    let requestCount = 0;
    for (const woeid of this.woeids.slice(0, window.requestBudget)) {
      const url = new URL('https://api.twitterapi.io/twitter/trends');
      url.searchParams.set('woeid', String(woeid));
      url.searchParams.set('count', '30');
      window.recordRequest?.();
      const payload = await this.request(url.toString(), apiKey, signal);
      requestCount += 1;
      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) throw this.invalid();
      for (const rawTrend of parsed.data.trends) {
        const trendResult = trendSchema.safeParse(rawTrend);
        if (!trendResult.success) continue;
        const trend = trendResult.data;
        const title = trend.name.trim();
        if (!title) continue;
        const query = trend.query?.trim() || encodeURIComponent(title);
        const externalId = trend.id === undefined || trend.id === null ? query : String(trend.id);
        const searchUrl = new URL('https://x.com/search');
        searchUrl.searchParams.set('q', title);
        const candidate = createTrendCandidate({
          sourceId: this.id,
          platform: this.label,
          externalId,
          title,
          url: searchUrl.toString(),
          publishedAt: null,
        });
        if (!candidate) continue;
        candidates.push(candidate);
        if (candidates.length >= window.maxCandidates) break;
      }
      if (candidates.length >= window.maxCandidates) break;
    }
    return { candidates, requestCount };
  }

  private async request(url: string, apiKey: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, { headers: { 'x-api-key': apiKey }, redirect: 'error', signal });
    } catch {
      if (signal.aborted) throw new TrendSourceError('TREND_SOURCE_ABORTED', 'TwitterAPI.io collection was aborted', true);
      throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'TwitterAPI.io is temporarily unavailable', true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new TrendSourceError('TREND_SOURCE_AUTH_FAILED', 'TwitterAPI.io credentials are unavailable', false);
    }
    if (response.status === 429) throw new TrendSourceError('TREND_SOURCE_RATE_LIMITED', 'TwitterAPI.io rate limit reached', true);
    if (!response.ok) throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'TwitterAPI.io is temporarily unavailable', response.status >= 500);
    try { return await readBoundedJson(response); } catch { throw this.invalid(); }
  }

  private invalid(): TrendSourceError {
    return new TrendSourceError('TREND_SOURCE_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid response', false);
  }
}
