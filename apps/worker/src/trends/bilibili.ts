import { z } from 'zod';
import { readBoundedJson } from './http.js';
import { TrendSourceError, type TrendSource, type TrendSourceResult, type TrendWindow } from './types.js';

const responseSchema = z.object({
  code: z.number().int(),
  data: z.object({
    list: z.array(z.unknown()).max(100),
  }).passthrough().optional().nullable(),
}).passthrough();
const itemSchema = z.object({
  bvid: z.string().regex(/^BV[A-Za-z0-9]+$/),
  title: z.string(),
  pubdate: z.number().int().nonnegative(),
}).passthrough();

const cleanTitle = (value: string): string => value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

export interface BilibiliTrendSourceConfig { limit?: number }

export class BilibiliTrendSource implements TrendSource {
  readonly id = 'bilibili-trends';
  readonly label = 'Bilibili';
  readonly minimumRequestBudget = 1;
  private readonly limit: number;

  constructor(config: BilibiliTrendSourceConfig, private readonly fetcher: typeof fetch = fetch) {
    this.limit = config.limit ?? 30;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 100) throw new Error('limit must be an integer from 1 to 100');
  }

  isEnabled(): boolean { return true; }

  async collect(window: TrendWindow, signal: AbortSignal): Promise<TrendSourceResult> {
    if (window.requestBudget === 0 || window.maxCandidates === 0) return { candidates: [], requestCount: 0 };
    const url = new URL('https://api.bilibili.com/x/web-interface/popular');
    url.searchParams.set('pn', '1');
    url.searchParams.set('ps', String(this.limit));
    window.recordRequest?.();
    const payload = await this.request(url.toString(), signal);
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.code !== 0 || !parsed.data.data) throw this.invalid();
    const candidates = [];
    for (const rawItem of parsed.data.data.list) {
      const itemResult = itemSchema.safeParse(rawItem);
      if (!itemResult.success) continue;
      const item = itemResult.data;
      const title = cleanTitle(item.title);
      if (!title) continue;
      candidates.push({
        sourceId: this.id,
        platform: this.label,
        externalId: item.bvid,
        title,
        url: `https://www.bilibili.com/video/${item.bvid}`,
        publishedAt: item.pubdate === 0 ? null : new Date(item.pubdate * 1_000).toISOString(),
      });
      if (candidates.length >= window.maxCandidates) break;
    }
    return { candidates, requestCount: 1 };
  }

  private async request(url: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, { headers: { accept: 'application/json', 'user-agent': 'LetterMate/0.1' }, signal });
    } catch {
      if (signal.aborted) throw new TrendSourceError('TREND_SOURCE_ABORTED', 'Bilibili collection was aborted', true);
      throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'Bilibili is temporarily unavailable', true);
    }
    if (response.status === 429) throw new TrendSourceError('TREND_SOURCE_RATE_LIMITED', 'Bilibili rate limit reached', true);
    if (!response.ok) throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'Bilibili is temporarily unavailable', response.status >= 500);
    try { return await readBoundedJson(response); } catch { throw this.invalid(); }
  }

  private invalid(): TrendSourceError {
    return new TrendSourceError('TREND_SOURCE_RESPONSE_INVALID', 'Bilibili returned an invalid response', false);
  }
}
