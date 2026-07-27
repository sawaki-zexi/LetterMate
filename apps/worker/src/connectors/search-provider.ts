import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const braveSchema = z.object({ web: z.object({ results: z.array(z.object({
  title: z.string().min(1), url: z.string().min(1), description: z.string().optional().nullable(),
  profile: z.object({ long_name: z.string().optional().nullable() }).optional(),
  page_age: z.string().optional().nullable(), age: z.string().optional().nullable(),
})).max(50) }).optional() });

export interface SearchProviderConfig {
  provider: 'brave'; apiKey?: string | undefined; baseUrl?: string; siteConstraints?: string[]; pageBudget?: number;
}

const httpUrl = (value: string): string => {
  try { const url = new URL(value); if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString(); } catch { /* safe error below */ }
  throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Search provider returned an invalid URL', false);
};
const iso = (value: string | null | undefined): string | null => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export class SearchProviderConnector implements SourceConnector {
  readonly id: string; readonly label: string; readonly sourceType = 'web' as const;
  private readonly pageBudget: number; private readonly sites: string[]; private readonly baseUrl: string;
  constructor(private readonly config: SearchProviderConfig, private readonly fetcher: typeof fetch = fetch) {
    this.id = `search-${config.provider}`; this.label = 'Brave Search';
    this.pageBudget = config.pageBudget ?? 1;
    if (!Number.isInteger(this.pageBudget) || this.pageBudget < 1 || this.pageBudget > 10) throw new Error('pageBudget must be from 1 to 10');
    this.sites = [...new Set(config.siteConstraints?.map((site) => site.trim().toLowerCase()).filter(Boolean) ?? [])];
    this.baseUrl = config.baseUrl ?? 'https://api.search.brave.com/res/v1/web/search';
  }
  isEnabled(): boolean { return Boolean(this.config.apiKey?.trim()); }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('web'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const key = this.config.apiKey?.trim();
    if (!key) throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', 'Search provider is not configured', false);
    const variants = plan.queries.flatMap((query) => [query, ...this.sites.map((site) => `${query} site:${site}`)]);
    const candidates = new Map<string, ConnectorResult['candidates'][number]>(); let requestCount = 0;
    for (const query of variants) {
      for (let page = 0; page < this.pageBudget && candidates.size < plan.maxCandidates; page += 1) {
        const url = new URL(this.baseUrl); url.searchParams.set('q', query); url.searchParams.set('count', '20');
        if (page > 0) url.searchParams.set('offset', String(page));
        const payload = await this.request(url, key, signal); requestCount += 1;
        const parsed = braveSchema.safeParse(payload);
        if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Search provider returned an invalid response', false);
        const results = parsed.data.web?.results ?? [];
        for (const item of results) {
          const urlValue = httpUrl(item.url);
          if (!candidates.has(urlValue)) candidates.set(urlValue, {
            connectorId: this.id, sourceType: this.sourceType, platform: this.label, externalId: urlValue,
            url: urlValue, title: item.title.trim(), content: null, excerpt: item.description?.trim() || null,
            authorName: item.profile?.long_name?.trim() || null, authorHandle: null,
            publishedAt: iso(item.page_age ?? item.age), language: null, engagement: {},
            proof: { kind: 'api_record', connectorId: this.id, externalId: urlValue },
          });
        }
        if (results.length === 0) break;
      }
    }
    return { candidates: [...candidates.values()].slice(0, plan.maxCandidates), requestCount };
  }

  private async request(url: URL, key: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try { response = await this.fetcher(url.toString(), { headers: { accept: 'application/json', 'x-subscription-token': key }, signal }); }
    catch { throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Search provider is temporarily unavailable', true); }
    if (response.status === 429) throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Search provider rate limit reached', true);
    if (response.status === 401 || response.status === 403) throw new ConnectorError('CONNECTOR_AUTH_FAILED', 'Search provider credentials are unavailable', false);
    if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Search provider is temporarily unavailable', response.status >= 500);
    try { return await response.json(); } catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Search provider returned an invalid response', false); }
  }
}
