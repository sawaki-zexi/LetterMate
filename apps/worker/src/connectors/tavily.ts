import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const endpoint = 'https://api.tavily.com/search';
const responseSchema = z.object({
  results: z.array(z.object({
    title: z.string().optional().nullable(),
    url: z.string().min(1),
    content: z.string().optional().nullable(),
    published_date: z.string().optional().nullable(),
  })).max(100),
});

export interface TavilyConnectorConfig {
  apiKey?: string | undefined;
  baseUrl?: string;
}

const toHttpUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const toDateOnly = (value: string): string => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Discovery time window is invalid', false);
  }
  return new Date(milliseconds).toISOString().slice(0, 10);
};

const toIsoTime = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

export class TavilyConnector implements SourceConnector {
  readonly id = 'search-tavily';
  readonly label = 'Tavily';
  readonly sourceType = 'web' as const;
  private readonly baseUrl: string;

  constructor(
    private readonly config: TavilyConnectorConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl ?? endpoint;
  }

  isEnabled(): boolean {
    return Boolean(this.config.apiKey?.trim());
  }

  supports(plan: SourceQueryPlan): boolean {
    return plan.sourceTypes.includes('web');
  }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const key = this.config.apiKey?.trim();
    if (!key) {
      throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', 'Tavily is not configured', false);
    }
    if (plan.maxCandidates <= 0) return { candidates: [], requestCount: 0 };

    const startDate = toDateOnly(plan.windowStart);
    const endDate = toDateOnly(plan.windowEnd);
    const candidates = new Map<string, ConnectorResult['candidates'][number]>();
    let requestCount = 0;
    for (const query of plan.queries) {
      if (candidates.size >= plan.maxCandidates) break;
      const payload = await this.request({
        query,
        search_depth: 'basic',
        chunks_per_source: 3,
        max_results: Math.min(20, plan.maxCandidates - candidates.size),
        topic: 'general',
        start_date: startDate,
        end_date: endDate,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_favicon: false,
      }, key, signal);
      requestCount += 1;
      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Tavily returned an invalid response', false);
      }
      for (const item of parsed.data.results) {
        const url = toHttpUrl(item.url);
        const title = item.title?.trim();
        if (url === null || !title || candidates.has(url)) continue;
        const excerpt = item.content?.replace(/\s+/g, ' ').trim() || null;
        candidates.set(url, {
          connectorId: this.id,
          sourceType: this.sourceType,
          platform: this.label,
          externalId: url,
          url,
          title,
          content: null,
          excerpt,
          authorName: null,
          authorHandle: null,
          publishedAt: toIsoTime(item.published_date),
          language: null,
          engagement: {},
          proof: { kind: 'api_record', connectorId: this.id, externalId: url },
        });
        if (candidates.size >= plan.maxCandidates) break;
      }
    }
    return { candidates: [...candidates.values()], requestCount };
  }

  private async request(body: Record<string, unknown>, key: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Tavily is temporarily unavailable', true);
    }
    if (response.status === 429) {
      throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Tavily rate limit reached', true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ConnectorError('CONNECTOR_AUTH_FAILED', 'Tavily credentials are unavailable', false);
    }
    if (!response.ok) {
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Tavily is temporarily unavailable', response.status >= 500);
    }
    try {
      return await response.json();
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Tavily returned an invalid response', false);
    }
  }
}
