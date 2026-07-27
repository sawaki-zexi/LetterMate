import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const API_BASE_URL = 'https://api.twitterapi.io';

const authorSchema = z.object({
  name: z.string().optional().nullable(),
  userName: z.string().optional().nullable(),
  username: z.string().optional().nullable(),
}).passthrough();

const entityUrlSchema = z.object({
  expanded_url: z.string().optional().nullable(),
  expandedUrl: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
}).passthrough();

const tweetSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  text: z.string(),
  createdAt: z.string().optional().nullable(),
  lang: z.string().optional().nullable(),
  likeCount: z.number().finite().nonnegative().optional().default(0),
  retweetCount: z.number().finite().nonnegative().optional().default(0),
  replyCount: z.number().finite().nonnegative().optional().default(0),
  quoteCount: z.number().finite().nonnegative().optional().default(0),
  viewCount: z.number().finite().nonnegative().optional().default(0),
  conversationId: z.string().optional().nullable(),
  isRetweet: z.boolean().optional().default(false),
  isQuote: z.boolean().optional().default(false),
  isThread: z.boolean().optional().default(false),
  author: authorSchema.optional().nullable(),
  entities: z.object({
    urls: z.array(entityUrlSchema).optional().default([]),
  }).optional().nullable(),
}).passthrough();

const searchResponseSchema = z.object({
  tweets: z.array(z.unknown()),
  has_next_page: z.boolean().optional(),
  hasNextPage: z.boolean().optional(),
  next_cursor: z.string().optional().nullable(),
  nextCursor: z.string().optional().nullable(),
}).passthrough();

const threadResponseSchema = z.object({
  replies: z.array(z.unknown()),
  has_next_page: z.boolean().optional(),
  hasNextPage: z.boolean().optional(),
  next_cursor: z.string().optional().nullable(),
  nextCursor: z.string().optional().nullable(),
}).passthrough();

type RawTweet = z.infer<typeof tweetSchema>;
type SearchResponse = z.infer<typeof searchResponseSchema>;
type ThreadResponse = z.infer<typeof threadResponseSchema>;

interface CandidateDraft {
  candidate: ConnectorResult['candidates'][number];
  isOriginalThread: boolean;
  authorHandle: string;
}

export interface TwitterApiIoConnectorConfig {
  apiKey: string | undefined;
  pageBudget?: number;
  queryBudget?: number;
  threadBudget?: number;
}

const asPositiveInteger = (value: number | undefined, fallback: number, name: string): number => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return result;
};

const toUnixSeconds = (value: string): string => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Discovery time window is invalid', false);
  }
  return String(Math.floor(milliseconds / 1_000));
};

const normalizeHandle = (value: string | null | undefined): string | null => {
  const result = value?.trim().replace(/^@/, '').toLowerCase() ?? '';
  return /^[a-z0-9_]{1,15}$/.test(result) ? result : null;
};

const toIsoTime = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

const asTweet = (value: unknown): RawTweet | null => {
  const parsed = tweetSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const nestedTweet = (tweet: RawTweet, keys: string[]): RawTweet | null => {
  for (const key of keys) {
    const nested = asTweet(tweet[key]);
    if (nested !== null) return nested;
  }
  return null;
};

const expandedUrls = (tweet: RawTweet): string[] => {
  const urls = tweet.entities?.urls ?? [];
  return [...new Set(urls.map((url) => url.expanded_url ?? url.expandedUrl ?? url.url)
    .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)))];
};

const composeContent = (tweet: RawTweet, quote: RawTweet | null): string => {
  const parts = [tweet.text.trim(), ...expandedUrls(tweet)];
  if (quote !== null && quote.text.trim()) parts.push(`Quoted post: ${quote.text.trim()}`);
  return parts.filter(Boolean).join('\n\n');
};

const titleFromText = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 280);

const isThreadMarker = (tweet: RawTweet): boolean => (
  tweet.conversationId === tweet.id && /(?:\bthread\b|🧵|\b1\s*\/\s*\d+)/i.test(tweet.text)
);

function mapHttpError(status: number): ConnectorError {
  if (status === 401 || status === 403) {
    return new ConnectorError('CONNECTOR_AUTH_FAILED', 'TwitterAPI.io credentials are unavailable', false);
  }
  if (status === 429) {
    return new ConnectorError('CONNECTOR_RATE_LIMITED', 'TwitterAPI.io rate limit reached', true);
  }
  if (status === 400 || status === 404) {
    return new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io request was rejected', false);
  }
  return new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'TwitterAPI.io is temporarily unavailable', true);
}

export class TwitterApiIoConnector implements SourceConnector {
  readonly id = 'twitterapi-io';
  readonly label = 'X';
  readonly sourceType = 'social' as const;
  private readonly pageBudget: number;
  private readonly queryBudget: number;
  private readonly threadBudget: number;

  constructor(
    private readonly config: TwitterApiIoConnectorConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.pageBudget = asPositiveInteger(config.pageBudget, 2, 'pageBudget');
    this.queryBudget = asPositiveInteger(config.queryBudget, 3, 'queryBudget');
    this.threadBudget = asPositiveInteger(config.threadBudget, 3, 'threadBudget');
  }

  isEnabled(): boolean {
    return Boolean(this.config.apiKey?.trim());
  }

  supports(plan: SourceQueryPlan): boolean {
    return plan.sourceTypes.includes('social');
  }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) {
      throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', 'TwitterAPI.io is not configured', false);
    }
    const drafts = new Map<string, CandidateDraft>();
    let requestCount = 0;
    const timeWindow = {
      sinceTime: toUnixSeconds(plan.windowStart),
      untilTime: toUnixSeconds(plan.windowEnd),
    };

    for (const query of plan.queries.slice(0, this.queryBudget)) {
      for (const queryType of ['Latest', 'Top'] as const) {
        let cursor: string | null = null;
        for (let page = 0; page < this.pageBudget && drafts.size < plan.maxCandidates; page += 1) {
          const response = await this.fetchSearch(query, queryType, cursor, timeWindow, apiKey, signal);
          requestCount += 1;
          for (const rawTweet of response.tweets) {
            const parsed = asTweet(rawTweet);
            if (parsed === null) {
              throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid tweet', false);
            }
            const normalized = this.normalizeTweet(parsed);
            if (normalized !== null && !drafts.has(normalized.candidate.externalId!)) {
              drafts.set(normalized.candidate.externalId!, normalized);
            }
          }
          if (response.tweets.length === 0) break;
          cursor = response.next_cursor ?? response.nextCursor ?? null;
          if (!(response.has_next_page ?? response.hasNextPage) || cursor === null) break;
        }
      }
    }

    for (const draft of [...drafts.values()]
      .filter((item) => item.isOriginalThread)
      .slice(0, this.threadBudget)) {
      const replies: unknown[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < this.pageBudget; page += 1) {
        const context = await this.fetchThreadContext(
          draft.candidate.externalId!,
          cursor,
          apiKey,
          signal,
        );
        requestCount += 1;
        replies.push(...context.replies);
        cursor = context.next_cursor ?? context.nextCursor ?? null;
        if (!(context.has_next_page ?? context.hasNextPage) || cursor === null) break;
      }
      const threadPosts = replies
        .map((reply) => {
          const parsed = asTweet(reply);
          if (parsed === null) {
            throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid tweet', false);
          }
          return parsed;
        })
        .filter((tweet) => normalizeHandle(tweet.author?.userName ?? tweet.author?.username) === draft.authorHandle)
        .sort((left, right) => (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0));
      const additions = threadPosts
        .filter((tweet) => String(tweet.id) !== draft.candidate.externalId)
        .map((tweet) => composeContent(tweet, null))
        .filter(Boolean);
      if (additions.length > 0) {
        draft.candidate.content = [draft.candidate.content, ...additions].filter(Boolean).join('\n\n');
      }
    }

    return { candidates: [...drafts.values()].map(({ candidate }) => candidate), requestCount };
  }

  private normalizeTweet(tweet: RawTweet): CandidateDraft | null {
    const retweeted = nestedTweet(tweet, ['retweeted_tweet', 'retweetedTweet']);
    const isRetweet = tweet.isRetweet || retweeted !== null;
    const original = isRetweet
      ? retweeted
      : tweet;
    if (original === null) return null;
    const authorHandle = normalizeHandle(original.author?.userName ?? original.author?.username);
    if (authorHandle === null || !original.id || !original.text.trim()) return null;
    const quote = nestedTweet(tweet, ['quoted_tweet', 'quotedTweet']);
    const content = composeContent(original, quote);
    return {
      candidate: {
        connectorId: this.id,
        sourceType: this.sourceType,
        platform: 'X',
        externalId: original.id,
        url: `https://x.com/${authorHandle}/status/${original.id}`,
        title: titleFromText(original.text),
        content,
        excerpt: null,
        authorName: original.author?.name?.trim() || null,
        authorHandle,
        publishedAt: toIsoTime(original.createdAt),
        language: original.lang?.trim() || null,
        engagement: {
          likes: original.likeCount,
          reposts: original.retweetCount,
          replies: original.replyCount,
          quotes: original.quoteCount,
          views: original.viewCount,
        },
        proof: { kind: 'api_record', connectorId: this.id, externalId: original.id },
      },
      isOriginalThread: !isRetweet && (original.isThread || isThreadMarker(original)),
      authorHandle,
    };
  }

  private async fetchSearch(
    query: string,
    queryType: 'Latest' | 'Top',
    cursor: string | null,
    timeWindow: { sinceTime: string; untilTime: string },
    apiKey: string,
    signal: AbortSignal,
  ): Promise<SearchResponse> {
    const url = new URL('/twitter/tweet/advanced_search', API_BASE_URL);
    url.searchParams.set(
      'query',
      `${query.trim()} since_time:${timeWindow.sinceTime} until_time:${timeWindow.untilTime}`,
    );
    url.searchParams.set('queryType', queryType);
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    const parsed = searchResponseSchema.safeParse(await this.request(url, apiKey, signal));
    if (!parsed.success) {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid response', false);
    }
    return parsed.data;
  }

  private async fetchThreadContext(
    tweetId: string,
    cursor: string | null,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<ThreadResponse> {
    const url = new URL('/twitter/tweet/thread_context', API_BASE_URL);
    url.searchParams.set('tweetId', tweetId);
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    const parsed = threadResponseSchema.safeParse(await this.request(url, apiKey, signal));
    if (!parsed.success) {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid response', false);
    }
    return parsed.data;
  }

  private async request(url: URL, apiKey: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        headers: { 'x-api-key': apiKey },
        signal,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'TwitterAPI.io is temporarily unavailable', true);
    }
    if (!response.ok) throw mapHttpError(response.status);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'TwitterAPI.io returned an invalid response', false);
    }
    return payload;
  }
}
