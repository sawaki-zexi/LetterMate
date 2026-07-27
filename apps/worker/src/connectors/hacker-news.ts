import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const endpoint = 'https://hn.algolia.com/api/v1/search_by_date';
const responseSchema = z.object({
  hits: z.array(z.object({
    objectID: z.string().min(1),
    title: z.string().optional().nullable(),
    story_title: z.string().optional().nullable(),
    story_text: z.string().optional().nullable(),
    comment_text: z.string().optional().nullable(),
    author: z.string().optional().nullable(),
    created_at: z.string().optional().nullable(),
    url: z.string().optional().nullable(),
    story_url: z.string().optional().nullable(),
  })).max(100),
});

const toUnixSeconds = (value: string): string => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Discovery time window is invalid', false);
  return String(Math.floor(milliseconds / 1_000));
};

const text = (value: string | null | undefined): string | null => value?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null;

export class HackerNewsConnector implements SourceConnector {
  readonly id = 'hacker-news';
  readonly label = 'Hacker News';
  readonly sourceType = 'community' as const;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  isEnabled(): boolean { return true; }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('community'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const url = new URL(endpoint);
    url.searchParams.set('query', plan.queries[0] ?? plan.keyword);
    url.searchParams.set('tags', 'story');
    url.searchParams.set('numericFilters', `created_at_i>${toUnixSeconds(plan.windowStart)}`);
    url.searchParams.set('hitsPerPage', String(Math.min(plan.maxCandidates, 100)));
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), { signal });
    } catch {
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Hacker News is temporarily unavailable', true);
    }
    if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Hacker News is temporarily unavailable', true);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Hacker News returned an invalid response', false); }
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Hacker News returned an invalid response', false);
    return {
      requestCount: 1,
      candidates: parsed.data.hits.map((hit) => {
        const title = text(hit.title ?? hit.story_title);
        const body = text(hit.story_text ?? hit.comment_text);
        return {
          connectorId: this.id, sourceType: this.sourceType, platform: 'Hacker News', externalId: hit.objectID,
          url: `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`,
          title, content: [body, hit.url ?? hit.story_url].filter(Boolean).join('\n\n') || null,
          excerpt: null, authorName: null, authorHandle: text(hit.author),
          publishedAt: hit.created_at && Number.isFinite(Date.parse(hit.created_at)) ? new Date(hit.created_at).toISOString() : null,
          language: 'en', engagement: {},
          proof: { kind: 'api_record' as const, connectorId: this.id, externalId: hit.objectID },
        };
      }),
    };
  }
}
