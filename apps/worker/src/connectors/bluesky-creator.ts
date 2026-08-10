import type { SourceCandidate } from '@lettermate/domain';
import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceQueryPlan } from './types.js';

const API_BASE_URL = 'https://public.api.bsky.app/xrpc';

const actorSchema = z.object({
  did: z.string().trim().startsWith('did:'),
  handle: z.string().trim().min(1),
  displayName: z.string().optional().nullable(),
}).passthrough();

const postRecordSchema = z.object({
  '$type': z.literal('app.bsky.feed.post'),
  text: z.string(),
  createdAt: z.string(),
}).passthrough();

const postViewSchema = z.object({
  uri: z.string().startsWith('at://'),
  cid: z.string().trim().min(1),
  author: actorSchema,
  record: postRecordSchema,
  likeCount: z.number().nonnegative().optional().default(0),
  repostCount: z.number().nonnegative().optional().default(0),
  replyCount: z.number().nonnegative().optional().default(0),
  quoteCount: z.number().nonnegative().optional().default(0),
  embed: z.unknown().optional().nullable(),
}).passthrough();

const feedViewSchema = z.object({
  post: postViewSchema,
  reason: z.unknown().optional().nullable(),
  reply: z.unknown().optional().nullable(),
}).passthrough();

const feedResponseSchema = z.object({
  feed: z.array(feedViewSchema).max(100),
  cursor: z.string().optional().nullable(),
}).passthrough();

const profileResponseSchema = actorSchema;

interface RecordView {
  uri: string;
  author: z.infer<typeof actorSchema>;
  value: z.infer<typeof postRecordSchema>;
}

const recordViewSchema = z.object({
  uri: z.string().startsWith('at://'),
  author: actorSchema,
  value: postRecordSchema,
}).passthrough();

const parseRecordView = (value: unknown): RecordView | null => {
  const parsed = recordViewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const atUriParts = (uri: string): { did: string; rkey: string } | null => {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(uri);
  return match?.[1] && match[2] ? { did: match[1], rkey: match[2] } : null;
};

const postUrl = (post: { uri: string; author: { handle: string } }): string | null => {
  const parsed = atUriParts(post.uri);
  if (!parsed || !post.author.handle.trim()) return null;
  return `https://bsky.app/profile/${encodeURIComponent(post.author.handle)}/post/${encodeURIComponent(parsed.rkey)}`;
};

const isoTime = (value: string): string | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const contentOf = (post: { record: { text: string } }, context?: RecordView | null): string => (
  [post.record.text.trim(), context?.value.text.trim() && `原帖上下文：${context.value.text.trim()}`]
    .filter(Boolean)
    .join('\n\n')
);

const reasonAuthorDid = (reason: unknown): string | null => {
  if (typeof reason !== 'object' || reason === null) return null;
  const value = reason as { $type?: unknown; by?: unknown };
  if (value.$type !== 'app.bsky.feed.defs#reasonRepost') return null;
  const actor = actorSchema.safeParse(value.by);
  return actor.success ? actor.data.did : null;
};

const quoteRecord = (embed: unknown): RecordView | null => {
  if (typeof embed !== 'object' || embed === null) return null;
  const value = embed as { record?: unknown };
  return parseRecordView(value.record);
};

const parentRecord = (reply: unknown): RecordView | null => {
  if (typeof reply !== 'object' || reply === null) return null;
  const value = reply as { parent?: unknown };
  return parseRecordView(value.parent);
};

export interface BlueskyCreatorConnectorConfig {
  did: string;
  pageBudget?: number;
}

export class BlueskyCreatorConnector {
  private readonly pageBudget: number;

  constructor(
    private readonly config: BlueskyCreatorConnectorConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!/^did:[a-z0-9]+:[a-z0-9:.%-]+$/i.test(config.did.trim())) {
      throw new Error('Bluesky DID is required');
    }
    this.pageBudget = config.pageBudget ?? 2;
    if (!Number.isInteger(this.pageBudget) || this.pageBudget < 1) {
      throw new Error('pageBudget must be positive');
    }
  }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const profileUrl = new URL(`${API_BASE_URL}/app.bsky.actor.getProfile`);
    profileUrl.searchParams.set('actor', this.config.did);
    const profile = this.parse(profileResponseSchema, await this.request(profileUrl, signal));

    const candidates: SourceCandidate[] = [];
    let requestCount = 1;
    let cursor: string | null = null;
    for (let page = 0; page < this.pageBudget && candidates.length < plan.maxCandidates; page += 1) {
      const feedUrl = new URL(`${API_BASE_URL}/app.bsky.feed.getAuthorFeed`);
      feedUrl.searchParams.set('actor', this.config.did);
      feedUrl.searchParams.set('limit', String(Math.min(100, Math.max(plan.maxCandidates, 1))));
      if (cursor) feedUrl.searchParams.set('cursor', cursor);
      const response = this.parse(feedResponseSchema, await this.request(feedUrl, signal));
      requestCount += 1;
      let reachedWindowStart = false;
      for (const entry of response.feed) {
        const normalized = this.normalize(entry, plan);
        if (normalized.reachedWindowStart) {
          reachedWindowStart = true;
        }
        if (normalized.candidate) candidates.push(normalized.candidate);
        if (candidates.length >= plan.maxCandidates) break;
      }
      cursor = response.cursor?.trim() || null;
      if (reachedWindowStart || !cursor || response.feed.length === 0) break;
    }

    return {
      candidates: candidates.slice(0, plan.maxCandidates),
      requestCount,
      identity: {
        displayName: profile.displayName?.trim() || profile.handle,
        profileUrl: `https://bsky.app/profile/${encodeURIComponent(profile.handle)}`,
        handle: `@${profile.handle}`.slice(0, 200),
      },
    };
  }

  private normalize(
    entry: z.infer<typeof feedViewSchema>,
    plan: SourceQueryPlan,
  ): { candidate: SourceCandidate | null; reachedWindowStart: boolean } {
    const post = entry.post;
    const repostedBy = reasonAuthorDid(entry.reason);
    const isRepost = repostedBy !== null;
    if (isRepost && repostedBy !== this.config.did) return { candidate: null, reachedWindowStart: false };
    if (!isRepost && post.author.did !== this.config.did) return { candidate: null, reachedWindowStart: false };
    const publishedAt = isoTime(post.record.createdAt);
    if (!publishedAt) return { candidate: null, reachedWindowStart: false };
    if (publishedAt < plan.windowStart) return { candidate: null, reachedWindowStart: true };
    if (publishedAt > plan.windowEnd) return { candidate: null, reachedWindowStart: false };

    const parent = parentRecord(entry.reply);
    const isReply = Boolean((post.record as { reply?: unknown }).reply);
    if (isReply && !parent) return { candidate: null, reachedWindowStart: false };
    const quote = quoteRecord(post.embed);
    const contentType = isReply || isRepost || quote ? 'repost' : 'original';
    const original = isRepost ? post : quote;
    const url = postUrl(post);
    if (!url || !post.record.text.trim()) return { candidate: null, reachedWindowStart: false };
    const content = contentOf(post, isReply ? parent : quote);
    return { candidate: {
      connectorId: 'bluesky-creator',
      sourceType: 'social',
      platform: 'Bluesky',
      externalId: post.uri,
      url,
      title: post.record.text.replace(/\s+/g, ' ').trim().slice(0, 280),
      content,
      excerpt: null,
      authorName: post.author.displayName?.trim() || null,
      authorHandle: post.author.handle,
      publishedAt,
      language: null,
      engagement: {
        likes: post.likeCount,
        reposts: post.repostCount,
        replies: post.replyCount,
        quotes: post.quoteCount,
      },
      proof: { kind: 'api_record', connectorId: 'bluesky-creator', externalId: post.uri },
      creatorContext: {
        contentType: contentType === 'repost' && !isReply ? 'repost' : isReply ? 'reply' : 'original',
        originalAuthorName: original?.author.displayName?.trim() || null,
        originalAuthorHandle: original?.author.handle ?? null,
        originalContentId: original?.uri ?? null,
        originalContentUrl: original ? postUrl(original) : null,
        parentContentId: parent?.uri ?? null,
        parentContentUrl: parent ? postUrl(parent) : null,
        parentContentText: parent?.value.text.trim().slice(0, 5_000) || null,
      },
    }, reachedWindowStart: false };
  }

  private async request(url: URL, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), { signal, headers: { accept: 'application/json' } });
    } catch {
      if (signal.aborted) throw new ConnectorError('CONNECTOR_ABORTED', 'Bluesky request was aborted', true);
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bluesky is temporarily unavailable', true);
    }
    if (response.status === 429) throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Bluesky rate limit reached', true);
    if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bluesky is temporarily unavailable', response.status >= 500);
    try {
      return await response.json();
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bluesky returned an invalid response', false);
    }
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bluesky returned an invalid response', false);
  }
}
