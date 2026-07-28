import { z } from 'zod';
import { TrendSourceError, type TrendSource, type TrendSourceResult, type TrendWindow } from './types.js';

const timestampSchema = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});
const responseSchema = z.object({
  items: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    snippet: z.object({ title: z.string(), publishedAt: timestampSchema }).passthrough(),
    statistics: z.record(z.string(), z.string()).optional(),
  }).passthrough()).max(50),
}).passthrough();

export interface YouTubeTrendSourceConfig {
  apiKey: string | undefined;
  region: string;
  maxResults?: number;
}

export class YouTubeTrendSource implements TrendSource {
  readonly id = 'youtube-trends';
  readonly label = 'YouTube';
  private readonly maxResults: number;

  constructor(private readonly config: YouTubeTrendSourceConfig, private readonly fetcher: typeof fetch = fetch) {
    if (!/^[A-Z]{2}$/.test(config.region)) throw new Error('region must be an uppercase ISO country code');
    this.maxResults = config.maxResults ?? 30;
    if (!Number.isInteger(this.maxResults) || this.maxResults < 1 || this.maxResults > 50) {
      throw new Error('maxResults must be an integer from 1 to 50');
    }
  }

  isEnabled(): boolean { return Boolean(this.config.apiKey?.trim()); }

  async collect(window: TrendWindow, signal: AbortSignal): Promise<TrendSourceResult> {
    if (window.requestBudget === 0 || window.maxCandidates === 0) return { candidates: [], requestCount: 0 };
    const key = this.config.apiKey?.trim();
    if (!key) throw new TrendSourceError('TREND_SOURCE_NOT_CONFIGURED', 'YouTube is not configured', false);
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'snippet,statistics');
    url.searchParams.set('chart', 'mostPopular');
    url.searchParams.set('regionCode', this.config.region);
    url.searchParams.set('maxResults', String(this.maxResults));
    url.searchParams.set('key', key);
    const payload = await this.request(url.toString(), signal);
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) throw this.invalid();
    const candidates = parsed.data.items.slice(0, window.maxCandidates).map((item) => {
      const title = item.snippet.title.trim();
      if (!title) throw this.invalid();
      return {
        sourceId: this.id,
        platform: this.label,
        externalId: item.id,
        title,
        url: `https://www.youtube.com/watch?v=${item.id}`,
        publishedAt: item.snippet.publishedAt,
      };
    });
    return { candidates, requestCount: 1 };
  }

  private async request(url: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try { response = await this.fetcher(url, { signal }); }
    catch {
      if (signal.aborted) throw new TrendSourceError('TREND_SOURCE_ABORTED', 'YouTube collection was aborted', true);
      throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'YouTube is temporarily unavailable', true);
    }
    if (response.status === 401 || response.status === 403) throw new TrendSourceError('TREND_SOURCE_AUTH_FAILED', 'YouTube credentials are unavailable', false);
    if (response.status === 429) throw new TrendSourceError('TREND_SOURCE_RATE_LIMITED', 'YouTube rate limit reached', true);
    if (!response.ok) throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'YouTube is temporarily unavailable', response.status >= 500);
    try { return await response.json(); } catch { throw this.invalid(); }
  }

  private invalid(): TrendSourceError {
    return new TrendSourceError('TREND_SOURCE_RESPONSE_INVALID', 'YouTube returned an invalid response', false);
  }
}
