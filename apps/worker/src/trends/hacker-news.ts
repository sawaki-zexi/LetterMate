import { z } from 'zod';
import { readBoundedJson } from './http.js';
import { TrendSourceError, type TrendSeedCandidate, type TrendSource, type TrendSourceResult, type TrendWindow } from './types.js';

const storyIdsSchema = z.array(z.number().int().positive()).max(500);
const storySchema = z.object({
  id: z.number().int().positive(),
  type: z.string(),
  title: z.string(),
  url: z.string().optional().nullable(),
  time: z.number().int().nonnegative(),
}).passthrough();

export class HackerNewsTrendSource implements TrendSource {
  readonly id = 'hacker-news-trends';
  readonly label = 'Hacker News';
  readonly minimumRequestBudget = 2;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  isEnabled(): boolean { return true; }

  async collect(window: TrendWindow, signal: AbortSignal): Promise<TrendSourceResult> {
    if (window.requestBudget === 0 || window.maxCandidates === 0) return { candidates: [], requestCount: 0 };
    window.recordRequest?.();
    const idsPayload = await this.request('https://hacker-news.firebaseio.com/v0/topstories.json', signal);
    let requestCount = 1;
    const ids = storyIdsSchema.safeParse(idsPayload);
    if (!ids.success) throw this.invalid();
    const candidates: TrendSeedCandidate[] = [];
    for (const id of ids.data.slice(0, Math.max(0, window.requestBudget - 1))) {
      window.recordRequest?.();
      const payload = await this.request(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, signal);
      requestCount += 1;
      const parsed = storySchema.safeParse(payload);
      if (!parsed.success) continue;
      const story = parsed.data;
      const title = story.title.trim();
      if (story.type !== 'story' || !title) continue;
      let url = `https://news.ycombinator.com/item?id=${story.id}`;
      if (story.url) {
        try {
          const parsedUrl = new URL(story.url);
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue;
          url = parsedUrl.toString();
        } catch { continue; }
      }
      candidates.push({
        sourceId: this.id,
        platform: this.label,
        externalId: String(story.id),
        title,
        url,
        publishedAt: new Date(story.time * 1_000).toISOString(),
      });
      if (candidates.length >= window.maxCandidates) break;
    }
    return { candidates, requestCount };
  }

  private async request(url: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try { response = await this.fetcher(url, { signal }); }
    catch {
      if (signal.aborted) throw new TrendSourceError('TREND_SOURCE_ABORTED', 'Hacker News collection was aborted', true);
      throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'Hacker News is temporarily unavailable', true);
    }
    if (response.status === 429) throw new TrendSourceError('TREND_SOURCE_RATE_LIMITED', 'Hacker News rate limit reached', true);
    if (!response.ok) throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'Hacker News is temporarily unavailable', response.status >= 500);
    try { return await readBoundedJson(response); } catch { throw this.invalid(); }
  }

  private invalid(): TrendSourceError {
    return new TrendSourceError('TREND_SOURCE_RESPONSE_INVALID', 'Hacker News returned an invalid response', false);
  }
}
