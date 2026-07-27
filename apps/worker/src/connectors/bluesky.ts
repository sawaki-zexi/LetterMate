import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const authorSchema = z.object({ did: z.string().startsWith('did:'), handle: z.string().min(1), displayName: z.string().optional().nullable() });
const recordSchema = z.object({ '$type': z.literal('app.bsky.feed.post'), text: z.string(), createdAt: z.string() }).passthrough();
const quotedSchema = z.object({
  '$type': z.literal('app.bsky.embed.record#view'), record: z.object({
    uri: z.string(), author: authorSchema, value: recordSchema.optional(), record: recordSchema.optional(),
  }).passthrough(),
});
const postSchema = z.object({
  uri: z.string(), cid: z.string().min(1), author: authorSchema, record: recordSchema,
  likeCount: z.number().nonnegative().optional().default(0), repostCount: z.number().nonnegative().optional().default(0),
  replyCount: z.number().nonnegative().optional().default(0), quoteCount: z.number().nonnegative().optional().default(0),
  embed: quotedSchema.optional(),
}).passthrough();
const responseSchema = z.object({ posts: z.array(postSchema).max(100) });
const parseAtUri = (uri: string): { rkey: string } | null => {
  const match = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(uri);
  return match?.[1] ? { rkey: match[1] } : null;
};

export class BlueskyConnector implements SourceConnector {
  readonly id = 'bluesky'; readonly label = 'Bluesky'; readonly sourceType = 'social' as const;
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  isEnabled(): boolean { return true; }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('social'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const candidates = new Map<string, ConnectorResult['candidates'][number]>(); let requestCount = 0;
    for (const query of plan.queries.slice(0, 3)) {
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts');
      url.searchParams.set('q', query); url.searchParams.set('sort', 'latest'); url.searchParams.set('limit', String(Math.min(plan.maxCandidates, 100)));
      const parsed = responseSchema.safeParse(await this.request(url, signal)); requestCount += 1;
      if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bluesky returned an invalid response', false);
      for (const post of parsed.data.posts) {
        const uri = parseAtUri(post.uri); const content = post.record.text.trim();
        if (uri === null || !content) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bluesky returned an invalid post', false);
        const quote = post.embed?.record.value ?? post.embed?.record.record;
        const quoteText = quote?.text.trim(); const combined = [content, quoteText && `Quoted post: ${quoteText}`].filter(Boolean).join('\n\n');
        const publishedAt = Number.isFinite(Date.parse(post.record.createdAt)) ? new Date(post.record.createdAt).toISOString() : null;
        candidates.set(post.uri, {
          connectorId: this.id, sourceType: this.sourceType, platform: 'Bluesky', externalId: post.uri,
          url: `https://bsky.app/profile/${encodeURIComponent(post.author.handle)}/post/${encodeURIComponent(uri.rkey)}`,
          title: content.replace(/\s+/g, ' ').slice(0, 280), content: combined, excerpt: null,
          authorName: post.author.displayName?.trim() || null, authorHandle: post.author.handle,
          publishedAt, language: null, engagement: { likes: post.likeCount, reposts: post.repostCount, replies: post.replyCount, quotes: post.quoteCount },
          proof: { kind: 'api_record', connectorId: this.id, externalId: post.uri },
        });
      }
    }
    return { candidates: [...candidates.values()].slice(0, plan.maxCandidates), requestCount };
  }
  private async request(url: URL, signal: AbortSignal): Promise<unknown> {
    let response: Response; try { response = await this.fetcher(url.toString(), { signal }); }
    catch { throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bluesky is temporarily unavailable', true); }
    if (response.status === 429) throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Bluesky rate limit reached', true);
    if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bluesky is temporarily unavailable', response.status >= 500);
    try { return await response.json(); } catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bluesky returned an invalid response', false); }
  }
}
