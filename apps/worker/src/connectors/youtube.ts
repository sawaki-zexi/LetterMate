import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const searchSchema = z.object({ items: z.array(z.object({ id: z.object({ videoId: z.string().min(1) }) })).max(50) });
const videoSchema = z.object({
  id: z.string().min(1), snippet: z.object({ title: z.string().min(1), description: z.string(),
    channelTitle: z.string().min(1), channelId: z.string().min(1), publishedAt: z.string() }),
  statistics: z.object({ viewCount: z.string().optional(), likeCount: z.string().optional(), commentCount: z.string().optional() }).optional(),
});
const videosSchema = z.object({ items: z.array(videoSchema).max(50) });
export interface YouTubeConnectorConfig { apiKey?: string; queryBudget?: number }
const count = (value: string | undefined): number => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; };

export class YouTubeConnector implements SourceConnector {
  readonly id = 'youtube'; readonly label = 'YouTube'; readonly sourceType = 'video' as const;
  private readonly queryBudget: number;
  constructor(private readonly config: YouTubeConnectorConfig, private readonly fetcher: typeof fetch = fetch) {
    this.queryBudget = config.queryBudget ?? 3;
    if (!Number.isInteger(this.queryBudget) || this.queryBudget < 1) throw new Error('queryBudget must be positive');
  }
  isEnabled(): boolean { return Boolean(this.config.apiKey?.trim()); }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('video'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const key = this.config.apiKey?.trim();
    if (!key) throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', 'YouTube is not configured', false);
    const candidates = new Map<string, ConnectorResult['candidates'][number]>(); let requestCount = 0;
    for (const query of plan.queries.slice(0, this.queryBudget)) {
      const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
      searchUrl.searchParams.set('part', 'snippet'); searchUrl.searchParams.set('type', 'video');
      searchUrl.searchParams.set('q', query); searchUrl.searchParams.set('publishedAfter', plan.windowStart);
      searchUrl.searchParams.set('publishedBefore', plan.windowEnd); searchUrl.searchParams.set('maxResults', String(Math.min(plan.maxCandidates, 50)));
      searchUrl.searchParams.set('key', key);
      const search = this.parse(searchSchema, await this.request(searchUrl, signal)); requestCount += 1;
      const ids = [...new Set(search.items.map((item) => item.id.videoId))]; if (ids.length === 0) continue;
      const videosUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
      videosUrl.searchParams.set('part', 'snippet,statistics'); videosUrl.searchParams.set('id', ids.join(',')); videosUrl.searchParams.set('key', key);
      const videos = this.parse(videosSchema, await this.request(videosUrl, signal)); requestCount += 1;
      for (const video of videos.items) {
        const description = video.snippet.description.trim(); if (!description || candidates.has(video.id)) continue;
        const publishedAt = Number.isFinite(Date.parse(video.snippet.publishedAt)) ? new Date(video.snippet.publishedAt).toISOString() : null;
        candidates.set(video.id, {
          connectorId: this.id, sourceType: this.sourceType, platform: 'YouTube', externalId: video.id,
          url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`, title: video.snippet.title.trim(), content: description,
          excerpt: null, authorName: video.snippet.channelTitle.trim(), authorHandle: video.snippet.channelId,
          publishedAt, language: null, engagement: { views: count(video.statistics?.viewCount), likes: count(video.statistics?.likeCount), comments: count(video.statistics?.commentCount) },
          proof: { kind: 'api_record', connectorId: this.id, externalId: video.id },
        });
      }
    }
    return { candidates: [...candidates.values()].slice(0, plan.maxCandidates), requestCount };
  }
  private async request(url: URL, signal: AbortSignal): Promise<unknown> {
    let response: Response; try { response = await this.fetcher(url.toString(), { signal }); }
    catch { throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'YouTube is temporarily unavailable', true); }
    if (response.status === 401 || response.status === 403) throw new ConnectorError('CONNECTOR_AUTH_FAILED', 'YouTube credentials are unavailable', false);
    if (response.status === 429) throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'YouTube rate limit reached', true);
    if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'YouTube is temporarily unavailable', response.status >= 500);
    try { return await response.json(); } catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'YouTube returned an invalid response', false); }
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (parsed.success) return parsed.data; throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'YouTube returned an invalid response', false); }
}
