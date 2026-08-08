import type { SourceCandidate } from '@lettermate/domain';
import { z } from 'zod';
import type { ConnectorResult, SourceQueryPlan } from './types.js';
import { ConnectorError } from './types.js';

const API_BASE_URL = 'https://api.twitterapi.io';

const authorSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  name: z.string().optional().nullable(),
  userName: z.string().optional().nullable(),
  username: z.string().optional().nullable(),
}).passthrough();

const entityUrlSchema = z.object({
  url: z.string().optional(),
  expanded_url: z.string().optional(),
  expandedUrl: z.string().optional(),
}).passthrough();

const tweetSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  url: z.string().optional().nullable(),
  text: z.string(),
  createdAt: z.string().optional().nullable(),
  lang: z.string().optional().nullable(),
  likeCount: z.number().finite().nonnegative().optional().default(0),
  retweetCount: z.number().finite().nonnegative().optional().default(0),
  replyCount: z.number().finite().nonnegative().optional().default(0),
  quoteCount: z.number().finite().nonnegative().optional().default(0),
  viewCount: z.number().finite().nonnegative().optional().default(0),
  isReply: z.boolean().optional().default(false),
  inReplyToId: z.union([z.string(), z.number()]).transform(String).optional().nullable(),
  inReplyToUsername: z.string().optional().nullable(),
  conversationId: z.union([z.string(), z.number()]).transform(String).optional().nullable(),
  isThread: z.boolean().optional().default(false),
  author: authorSchema.optional().nullable(),
  entities: z.object({ urls: z.array(entityUrlSchema).optional().default([]) }).optional().nullable(),
}).passthrough();

const timelineResponseSchema = z.object({
  tweets: z.array(z.unknown()).optional(),
  data: z.object({ tweets: z.array(z.unknown()) }).passthrough().optional(),
  has_next_page: z.boolean().optional(),
  next_cursor: z.string().optional().nullable(),
}).passthrough()
  .refine((response) => response.tweets !== undefined || response.data?.tweets !== undefined)
  .transform((response) => ({
    ...response,
    tweets: response.tweets ?? response.data?.tweets ?? [],
  }));

const tweetsResponseSchema = z.object({ tweets: z.array(z.unknown()) }).passthrough();
const threadResponseSchema = z.object({
  replies: z.array(z.unknown()).optional(),
  tweets: z.array(z.unknown()).optional(),
  has_next_page: z.boolean().optional(),
  next_cursor: z.string().optional().nullable(),
}).passthrough()
  .refine((response) => response.tweets !== undefined || response.replies !== undefined)
  .transform((response) => ({
    ...response,
    replies: response.tweets ?? response.replies ?? [],
  }));
type RawTweet = z.infer<typeof tweetSchema>;

export interface XCreatorConnectorConfig {
  apiKey: string | undefined;
  userId: string;
  pageBudget?: number;
  threadBudget?: number;
}

const asTweet = (value: unknown): RawTweet | null => {
  const parsed = tweetSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const nestedTweet = (tweet: RawTweet, keys: string[]): RawTweet | null => {
  for (const key of keys) {
    const nested = asTweet(tweet[key]);
    if (nested) return nested;
  }
  return null;
};

const handleOf = (tweet: RawTweet): string | null => {
  const handle = (tweet.author?.userName ?? tweet.author?.username)?.trim().replace(/^@/, '') ?? '';
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
};

const isoTime = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const postUrl = (tweet: RawTweet): string | null => {
  if (tweet.url && /^https?:\/\//i.test(tweet.url)) return tweet.url;
  const handle = handleOf(tweet);
  return handle ? `https://x.com/${handle}/status/${tweet.id}` : null;
};

const expandedUrls = (tweet: RawTweet): string[] => [...new Set(
  (tweet.entities?.urls ?? [])
    .map((item) => item.expanded_url ?? item.expandedUrl ?? item.url)
    .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)),
)];

const contentOf = (tweet: RawTweet, referenced: RawTweet | null): string => [
  tweet.text.trim(),
  ...expandedUrls(tweet),
  referenced?.text.trim() ? `原帖：${referenced.text.trim()}` : null,
].filter((part): part is string => Boolean(part)).join('\n\n');

const shortSocialReply = (tweet: RawTweet): boolean => {
  if (!tweet.isReply && !tweet.inReplyToId) return false;
  const substantive = tweet.text.replace(/^(?:\s*@[A-Za-z0-9_]{1,15})+\s*/, '').trim();
  const engagement = tweet.likeCount + tweet.retweetCount + tweet.replyCount + tweet.quoteCount;
  return substantive.length < 60 && expandedUrls(tweet).length === 0 && engagement < 20;
};

function httpError(status: number): ConnectorError {
  if (status === 401 || status === 403) return new ConnectorError('CONNECTOR_AUTH_FAILED', 'TwitterAPI.io credentials are unavailable', false);
  if (status === 429) return new ConnectorError('CONNECTOR_RATE_LIMITED', 'TwitterAPI.io rate limit reached', true);
  if (status === 400 || status === 404) return new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io request was rejected', false);
  return new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'TwitterAPI.io is temporarily unavailable', true);
}

export class XCreatorConnector {
  private readonly pageBudget: number;
  private readonly threadBudget: number;

  constructor(
    private readonly config: XCreatorConnectorConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.pageBudget = config.pageBudget ?? 2;
    this.threadBudget = config.threadBudget ?? 3;
    if (!Number.isInteger(this.pageBudget) || this.pageBudget < 1) throw new Error('pageBudget must be positive');
    if (!Number.isInteger(this.threadBudget) || this.threadBudget < 1) throw new Error('threadBudget must be positive');
  }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', 'TwitterAPI.io is not configured', false);
    const tweets: RawTweet[] = [];
    let cursor: string | null = null;
    let requestCount = 0;
    for (let page = 0; page < this.pageBudget && tweets.length < plan.maxCandidates; page += 1) {
      const url = new URL('/twitter/user/tweet_timeline', API_BASE_URL);
      url.searchParams.set('userId', this.config.userId);
      url.searchParams.set('includeReplies', 'true');
      url.searchParams.set('includeParentTweet', 'true');
      if (cursor) url.searchParams.set('cursor', cursor);
      const parsed = timelineResponseSchema.safeParse(await this.request(url, apiKey, signal));
      requestCount += 1;
      if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid timeline', false);
      for (const value of parsed.data.tweets) {
        const tweet = asTweet(value);
        if (!tweet) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid tweet', false);
        tweets.push(tweet);
      }
      cursor = parsed.data.next_cursor ?? null;
      if (!parsed.data.has_next_page || !cursor || parsed.data.tweets.length === 0) break;
    }

    const parents = await this.fetchMissingParents(tweets, apiKey, signal);
    if (parents.requested) requestCount += 1;
    const threads = await this.fetchThreads(tweets, apiKey, signal);
    requestCount += threads.requestCount;
    const candidates = tweets
      .filter((tweet) => {
        const publishedAt = isoTime(tweet.createdAt);
        return !shortSocialReply(tweet)
          && (!publishedAt || (publishedAt >= plan.windowStart && publishedAt <= plan.windowEnd));
      })
      .filter((tweet) => !threads.childIds.has(tweet.id))
      .map((tweet) => this.normalize(tweet, parents.byId, threads.additions.get(tweet.id) ?? []))
      .filter((candidate): candidate is SourceCandidate => candidate !== null)
      .slice(0, plan.maxCandidates);
    const identityTweet = tweets.find((tweet) => tweet.author?.id === this.config.userId);
    const identityHandle = identityTweet ? handleOf(identityTweet) : null;
    return {
      candidates,
      requestCount,
      ...(identityTweet?.author?.name && identityHandle
        ? {
            identity: {
              displayName: identityTweet.author.name.trim().slice(0, 200),
              profileUrl: `https://x.com/${identityHandle}`,
              handle: `@${identityHandle}`,
            },
          }
        : {}),
    };
  }

  private normalize(tweet: RawTweet, parents: Map<string, RawTweet>, threadAdditions: string[]): SourceCandidate | null {
    const retweeted = nestedTweet(tweet, ['retweeted_tweet', 'retweetedTweet']);
    const quoted = nestedTweet(tweet, ['quoted_tweet', 'quotedTweet']);
    const parent = nestedTweet(tweet, ['parent_tweet', 'parentTweet'])
      ?? (tweet.inReplyToId ? parents.get(tweet.inReplyToId) ?? null : null);
    const isReply = tweet.isReply || Boolean(tweet.inReplyToId);
    if (isReply && !parent) return null;
    const contentType = isReply ? 'reply' : retweeted || quoted ? 'repost' : 'original';
    const primary = retweeted ?? tweet;
    const reference = retweeted ?? quoted ?? parent;
    const url = postUrl(tweet) ?? postUrl(primary);
    const author = retweeted ? primary : tweet;
    const authorHandle = handleOf(author);
    if (!url || !authorHandle || !primary.text.trim()) return null;
    const original = retweeted ?? quoted;
    return {
      connectorId: 'twitterapi-io-x-creator',
      sourceType: 'social',
      platform: 'X',
      externalId: tweet.id,
      url,
      title: primary.text.replace(/\s+/g, ' ').trim().slice(0, 280),
      content: [
        contentOf(retweeted ? primary : tweet, retweeted ? null : reference === tweet ? null : reference),
        ...threadAdditions,
      ].filter(Boolean).join('\n\n'),
      excerpt: null,
      authorName: author.author?.name?.trim() || null,
      authorHandle,
      publishedAt: isoTime(tweet.createdAt),
      language: tweet.lang?.trim() || null,
      engagement: {
        likes: tweet.likeCount,
        reposts: tweet.retweetCount,
        replies: tweet.replyCount,
        quotes: tweet.quoteCount,
        views: tweet.viewCount,
      },
      proof: { kind: 'api_record', connectorId: 'twitterapi-io-x-creator', externalId: tweet.id },
      creatorContext: {
        contentType,
        originalAuthorName: original?.author?.name?.trim() || null,
        originalAuthorHandle: original ? handleOf(original) : null,
        originalContentId: original?.id ?? null,
        originalContentUrl: original ? postUrl(original) : null,
        parentContentId: parent?.id ?? null,
        parentContentUrl: parent ? postUrl(parent) : null,
        parentContentText: parent?.text.trim().slice(0, 5_000) || null,
      },
    };
  }

  private async fetchMissingParents(
    tweets: RawTweet[],
    apiKey: string,
    signal: AbortSignal,
  ): Promise<{ byId: Map<string, RawTweet>; requested: boolean }> {
    const parentIds = [...new Set(tweets.flatMap((tweet) => {
      if (!(tweet.isReply || tweet.inReplyToId) || !tweet.inReplyToId) return [];
      return nestedTweet(tweet, ['parent_tweet', 'parentTweet']) ? [] : [tweet.inReplyToId];
    }))];
    if (parentIds.length === 0) return { byId: new Map(), requested: false };
    const url = new URL('/twitter/tweets', API_BASE_URL);
    url.searchParams.set('tweet_ids', parentIds.join(','));
    const parsed = tweetsResponseSchema.safeParse(await this.request(url, apiKey, signal));
    if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned invalid parent posts', false);
    const byId = new Map<string, RawTweet>();
    for (const value of parsed.data.tweets) {
      const tweet = asTweet(value);
      if (!tweet) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid parent post', false);
      byId.set(tweet.id, tweet);
    }
    return { byId, requested: true };
  }

  private async fetchThreads(
    tweets: RawTweet[],
    apiKey: string,
    signal: AbortSignal,
  ): Promise<{ additions: Map<string, string[]>; childIds: Set<string>; requestCount: number }> {
    const roots = tweets.filter((tweet) => (
      tweet.isThread
      || (tweet.conversationId === tweet.id && /(?:\bthread\b|\b1\s*\/\s*\d+)/i.test(tweet.text))
    )).slice(0, this.threadBudget);
    const additions = new Map<string, string[]>();
    const childIds = new Set<string>();
    let requestCount = 0;
    for (const root of roots) {
      const rootHandle = handleOf(root);
      if (!rootHandle) continue;
      const posts: RawTweet[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < this.pageBudget; page += 1) {
        const url = new URL('/twitter/tweet/thread_context', API_BASE_URL);
        url.searchParams.set('tweetId', root.id);
        if (cursor) url.searchParams.set('cursor', cursor);
        const parsed = threadResponseSchema.safeParse(await this.request(url, apiKey, signal));
        requestCount += 1;
        if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned invalid thread context', false);
        for (const value of parsed.data.replies) {
          const post = asTweet(value);
          if (!post) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid thread post', false);
          if (post.id !== root.id && handleOf(post)?.toLowerCase() === rootHandle.toLowerCase()) posts.push(post);
        }
        cursor = parsed.data.next_cursor ?? null;
        if (!parsed.data.has_next_page || !cursor || parsed.data.replies.length === 0) break;
      }
      posts.sort((left, right) => (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0));
      additions.set(root.id, posts.map((post) => contentOf(post, null)).filter(Boolean));
      posts.forEach((post) => childIds.add(post.id));
    }
    return { additions, childIds, requestCount };
  }

  private async request(url: URL, apiKey: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), { headers: { 'x-api-key': apiKey }, signal });
    } catch {
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'TwitterAPI.io is temporarily unavailable', true);
    }
    if (!response.ok) throw httpError(response.status);
    try {
      return await response.json();
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid response', false);
    }
  }
}
