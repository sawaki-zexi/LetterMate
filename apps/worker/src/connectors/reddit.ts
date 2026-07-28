import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const tokenSchema = z.object({ access_token: z.string().min(1), token_type: z.string(), expires_in: z.number() });
const postSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), title: z.string().min(1), selftext: z.string().optional().default(''),
  permalink: z.string().startsWith('/'), url: z.string().optional().nullable(), author: z.string().optional().nullable(),
  created_utc: z.number().finite().nonnegative(), score: z.number().finite().optional().default(0),
  num_comments: z.number().finite().nonnegative().optional().default(0),
});
const searchSchema = z.object({ data: z.object({ children: z.array(z.object({ data: postSchema })).max(100) }) });
export interface RedditConnectorConfig {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  queryBudget?: number;
}

export class RedditConnector implements SourceConnector {
  readonly id = 'reddit'; readonly label = 'Reddit'; readonly sourceType = 'community' as const;
  private readonly queryBudget: number;
  constructor(private readonly config: RedditConnectorConfig, private readonly fetcher: typeof fetch = fetch) {
    this.queryBudget = config.queryBudget ?? 3;
    if (!Number.isInteger(this.queryBudget) || this.queryBudget < 1) throw new Error('queryBudget must be positive');
  }
  isEnabled(): boolean { return Boolean(this.config.clientId?.trim() && this.config.clientSecret?.trim()); }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('community'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const clientId = this.config.clientId?.trim(); const secret = this.config.clientSecret?.trim();
    if (!clientId || !secret) throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', 'Reddit is not configured', false);
    const token = await this.getToken(clientId, secret, signal); let requestCount = 1;
    const candidates = new Map<string, ConnectorResult['candidates'][number]>();
    for (const query of plan.queries.slice(0, this.queryBudget)) {
      const url = new URL('https://oauth.reddit.com/search'); url.searchParams.set('q', query);
      url.searchParams.set('sort', 'new'); url.searchParams.set('t', 'week'); url.searchParams.set('raw_json', '1');
      url.searchParams.set('limit', String(Math.min(plan.maxCandidates, 100)));
      const payload = await this.request(url, { authorization: `Bearer ${token}`, 'user-agent': 'LetterMate/0.1' }, signal);
      requestCount += 1; const parsed = this.parse(searchSchema, payload);
      for (const { data: post } of parsed.data.children) {
        const permalink = new URL(post.permalink, 'https://www.reddit.com');
        if (permalink.hostname !== 'www.reddit.com') throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Reddit returned an invalid permalink', false);
        const externalUrl = post.url && /^https?:\/\//i.test(post.url) && post.url !== permalink.toString() ? post.url : null;
        const content = [post.selftext.trim(), externalUrl].filter(Boolean).join('\n\n');
        if (!content || candidates.has(post.name)) continue;
        candidates.set(post.name, {
          connectorId: this.id, sourceType: this.sourceType, platform: 'Reddit', externalId: post.name,
          url: permalink.toString(), title: post.title.trim(), content, excerpt: null, authorName: null,
          authorHandle: post.author?.trim() || null, publishedAt: new Date(post.created_utc * 1_000).toISOString(),
          language: null, engagement: { score: Math.max(0, post.score), comments: post.num_comments },
          proof: { kind: 'api_record', connectorId: this.id, externalId: post.name },
        });
      }
    }
    return { candidates: [...candidates.values()].slice(0, plan.maxCandidates), requestCount };
  }
  private async getToken(id: string, secret: string, signal: AbortSignal): Promise<string> {
    const url = new URL('https://www.reddit.com/api/v1/access_token');
    const payload = await this.request(url, {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'LetterMate/0.1',
    }, signal, { method: 'POST', body: 'grant_type=client_credentials' });
    return this.parse(tokenSchema, payload).access_token;
  }
  private async request(url: URL, headers: Record<string, string>, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
    let response: Response; try { response = await this.fetcher(url.toString(), { ...init, headers, signal }); }
    catch { throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Reddit is temporarily unavailable', true); }
    if (response.status === 401 || response.status === 403) throw new ConnectorError('CONNECTOR_AUTH_FAILED', 'Reddit credentials are unavailable', false);
    if (response.status === 429) throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Reddit rate limit reached', true);
    if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Reddit is temporarily unavailable', response.status >= 500);
    try { return await response.json(); } catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Reddit returned an invalid response', false); }
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (parsed.success) return parsed.data; throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Reddit returned an invalid response', false); }
}
