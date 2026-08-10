import type { SourceCandidate } from '@lettermate/domain';
import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceQueryPlan } from './types.js';

const API_BASE_URL = 'https://www.googleapis.com/youtube/v3';
const thumbnailSchema = z.object({ url: z.string().url() }).passthrough();
const channelSchema = z.object({
  id: z.string().trim().min(1),
  snippet: z.object({
    title: z.string().trim().min(1),
    customUrl: z.string().optional().nullable(),
  }).passthrough(),
  contentDetails: z.object({
    relatedPlaylists: z.object({ uploads: z.string().trim().min(1) }).passthrough(),
  }).passthrough(),
}).passthrough();
const channelsResponseSchema = z.object({ items: z.array(channelSchema).max(50) }).passthrough();
const playlistItemSchema = z.object({
  contentDetails: z.object({ videoId: z.string().trim().min(1) }).passthrough(),
  snippet: z.object({
    publishedAt: z.string(),
    videoOwnerChannelId: z.string().optional().nullable(),
  }).passthrough(),
}).passthrough();
const playlistResponseSchema = z.object({
  items: z.array(playlistItemSchema).max(50),
  nextPageToken: z.string().optional().nullable(),
}).passthrough();
const videoSchema = z.object({
  id: z.string().trim().min(1),
  snippet: z.object({
    title: z.string().trim().min(1),
    description: z.string().optional().default(''),
    channelTitle: z.string().trim().min(1),
    channelId: z.string().trim().min(1),
    publishedAt: z.string(),
    defaultAudioLanguage: z.string().optional().nullable(),
    defaultLanguage: z.string().optional().nullable(),
    thumbnails: z.record(z.string(), thumbnailSchema).optional().default({}),
  }).passthrough(),
  statistics: z.object({
    viewCount: z.string().optional(),
    likeCount: z.string().optional(),
    commentCount: z.string().optional(),
  }).optional(),
}).passthrough();
const videosResponseSchema = z.object({ items: z.array(videoSchema).max(50) }).passthrough();

export interface YouTubeCreatorConnectorConfig {
  apiKey: string | undefined;
  channelId: string;
  pageBudget?: number;
}

const count = (value: string | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const isoTime = (value: string): string | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

function providerError(status: number): ConnectorError {
  if (status === 401 || status === 403) {
    return new ConnectorError('CONNECTOR_AUTH_FAILED', 'YouTube credentials are unavailable', false);
  }
  if (status === 429) return new ConnectorError('CONNECTOR_RATE_LIMITED', 'YouTube rate limit reached', true);
  if (status === 400 || status === 404) {
    return new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'YouTube channel request was rejected', false);
  }
  return new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'YouTube is temporarily unavailable', true);
}

export class YouTubeCreatorConnector {
  private readonly pageBudget: number;

  constructor(
    private readonly config: YouTubeCreatorConnectorConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!config.channelId.trim()) throw new Error('YouTube channelId is required');
    this.pageBudget = config.pageBudget ?? 2;
    if (!Number.isInteger(this.pageBudget) || this.pageBudget < 1) throw new Error('pageBudget must be positive');
  }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const key = this.config.apiKey?.trim();
    if (!key) throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', 'YouTube is not configured', false);
    const channelUrl = new URL('/youtube/v3/channels', API_BASE_URL);
    channelUrl.searchParams.set('part', 'snippet,contentDetails');
    channelUrl.searchParams.set('id', this.config.channelId);
    channelUrl.searchParams.set('key', key);
    const channels = this.parse(channelsResponseSchema, await this.request(channelUrl, signal));
    const channel = channels.items.find((item) => item.id === this.config.channelId);
    if (!channel) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'YouTube channel is unavailable', false);

    let requestCount = 1;
    let pageToken: string | null = null;
    const videoIds = new Set<string>();
    for (let page = 0; page < this.pageBudget && videoIds.size < plan.maxCandidates; page += 1) {
      const playlistUrl = new URL('/youtube/v3/playlistItems', API_BASE_URL);
      playlistUrl.searchParams.set('part', 'snippet,contentDetails');
      playlistUrl.searchParams.set('playlistId', channel.contentDetails.relatedPlaylists.uploads);
      playlistUrl.searchParams.set('maxResults', String(Math.min(50, plan.maxCandidates)));
      playlistUrl.searchParams.set('key', key);
      if (pageToken) playlistUrl.searchParams.set('pageToken', pageToken);
      const response = this.parse(playlistResponseSchema, await this.request(playlistUrl, signal));
      requestCount += 1;
      let reachedWindowStart = false;
      for (const item of response.items) {
        if (item.snippet.videoOwnerChannelId && item.snippet.videoOwnerChannelId !== this.config.channelId) continue;
        const publishedAt = isoTime(item.snippet.publishedAt);
        if (publishedAt && publishedAt < plan.windowStart) {
          reachedWindowStart = true;
          continue;
        }
        if (!publishedAt || publishedAt <= plan.windowEnd) videoIds.add(item.contentDetails.videoId);
        if (videoIds.size >= plan.maxCandidates) break;
      }
      pageToken = response.nextPageToken?.trim() || null;
      if (reachedWindowStart || !pageToken || response.items.length === 0) break;
    }

    const candidates: SourceCandidate[] = [];
    if (videoIds.size > 0) {
      const videosUrl = new URL('/youtube/v3/videos', API_BASE_URL);
      videosUrl.searchParams.set('part', 'snippet,statistics');
      videosUrl.searchParams.set('id', [...videoIds].join(','));
      videosUrl.searchParams.set('key', key);
      const videos = this.parse(videosResponseSchema, await this.request(videosUrl, signal));
      requestCount += 1;
      for (const video of videos.items) {
        const publishedAt = isoTime(video.snippet.publishedAt);
        if (
          video.snippet.channelId !== this.config.channelId
          || (publishedAt && (publishedAt < plan.windowStart || publishedAt > plan.windowEnd))
        ) continue;
        const description = video.snippet.description.trim();
        candidates.push({
          connectorId: 'youtube-creator',
          sourceType: 'video',
          platform: 'YouTube',
          externalId: video.id,
          url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
          title: video.snippet.title,
          content: description || video.snippet.title,
          excerpt: null,
          authorName: video.snippet.channelTitle,
          authorHandle: this.config.channelId,
          publishedAt,
          language: video.snippet.defaultAudioLanguage ?? video.snippet.defaultLanguage ?? null,
          engagement: {
            views: count(video.statistics?.viewCount),
            likes: count(video.statistics?.likeCount),
            comments: count(video.statistics?.commentCount),
          },
          proof: { kind: 'api_record', connectorId: 'youtube-creator', externalId: video.id },
          creatorContext: {
            contentType: 'original',
            originalAuthorName: null,
            originalAuthorHandle: null,
            originalContentId: null,
            originalContentUrl: null,
            parentContentId: null,
            parentContentUrl: null,
            parentContentText: null,
          },
        });
      }
    }

    const handle = channel.snippet.customUrl?.trim().replace(/^@/, '') || null;
    return {
      candidates: candidates.slice(0, plan.maxCandidates),
      requestCount,
      identity: {
        displayName: channel.snippet.title.slice(0, 200),
        profileUrl: `https://www.youtube.com/channel/${encodeURIComponent(channel.id)}`,
        handle: handle ? `@${handle}`.slice(0, 200) : null,
      },
    };
  }

  private async request(url: URL, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), { signal, headers: { accept: 'application/json' } });
    } catch {
      if (signal.aborted) throw new ConnectorError('CONNECTOR_ABORTED', 'YouTube request was aborted', true);
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'YouTube is temporarily unavailable', true);
    }
    if (!response.ok) throw providerError(response.status);
    try {
      return await response.json();
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'YouTube returned an invalid response', false);
    }
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'YouTube returned an invalid response', false);
  }
}
