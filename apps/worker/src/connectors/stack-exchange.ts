import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const responseSchema = z.object({
  items: z.array(z.object({
    question_id: z.number().int().positive(),
    title: z.string().min(1),
    link: z.url(),
    body: z.string().optional().nullable(),
    tags: z.array(z.string()).optional().default([]),
    is_answered: z.boolean().optional().default(false),
    answer_count: z.number().int().nonnegative().optional().default(0),
    score: z.number().int().optional().default(0),
    view_count: z.number().int().nonnegative().optional().default(0),
    last_activity_date: z.number().int().nonnegative().optional().nullable(),
    owner: z.object({ display_name: z.string().optional().nullable(), user_id: z.number().int().optional() }).optional().nullable(),
  })).max(100),
});

const stripHtml = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const text = value.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
  return text || null;
};

const isoFromUnix = (value: number | null | undefined): string | null => (
  value === null || value === undefined ? null : new Date(value * 1_000).toISOString()
);

export class StackExchangeConnector implements SourceConnector {
  readonly id = 'stack-overflow';
  readonly label = 'Stack Overflow';
  readonly sourceType = 'community' as const;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  isEnabled(): boolean { return true; }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('community'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('sort', 'activity');
    url.searchParams.set('site', 'stackoverflow');
    url.searchParams.set('q', plan.queries[0] ?? plan.keyword);
    url.searchParams.set('filter', 'withbody');
    url.searchParams.set('pagesize', String(Math.min(plan.maxCandidates, 100)));
    let response: Response;
    try { response = await this.fetcher(url.toString(), { signal }); }
    catch { throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Stack Overflow is temporarily unavailable', true); }
    if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Stack Overflow is temporarily unavailable', response.status >= 500);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Stack Overflow returned an invalid response', false); }
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Stack Overflow returned an invalid response', false);
    const candidates = parsed.data.items
      .filter((item) => item.is_answered && item.answer_count > 0)
      .slice(0, plan.maxCandidates)
      .map((item) => ({
        connectorId: this.id,
        sourceType: this.sourceType,
        platform: 'Stack Overflow',
        externalId: String(item.question_id),
        url: item.link,
        title: item.title,
        content: [stripHtml(item.body), item.tags.length > 0 ? `Tags: ${item.tags.join(', ')}` : null]
          .filter((value): value is string => value !== null)
          .join('\n\n') || null,
        excerpt: null,
        authorName: item.owner?.display_name ?? null,
        authorHandle: item.owner?.user_id === undefined ? null : String(item.owner.user_id),
        publishedAt: isoFromUnix(item.last_activity_date),
        language: 'en',
        engagement: { score: Math.max(0, item.score), answers: item.answer_count, views: item.view_count },
        proof: { kind: 'api_record' as const, connectorId: this.id, externalId: String(item.question_id) },
      }));
    return { candidates, requestCount: 1 };
  }
}
