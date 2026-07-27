import { canonicalizeUrl } from '@lettermate/domain';
import { z } from 'zod';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const resultSchema = z.object({ results: z.array(z.object({
  url: z.url(), title: z.string().min(1), excerpt: z.string().optional().nullable(),
  publishedAt: z.string().optional().nullable(),
})).max(30) });
const citationSchema = z.object({ type: z.literal('url_citation'), url_citation: z.object({ url: z.url(), title: z.string().optional() }) });
const responseSchema = z.object({ choices: z.array(z.object({ message: z.object({
  content: z.string(), annotations: z.array(z.unknown()).optional().default([]),
}) })).min(1) });
export interface OpenRouterSearchConfig { apiKey?: string | undefined; model: string; webSearch: boolean; timeoutMs: number }

export class OpenRouterSearchConnector implements SourceConnector {
  readonly id = 'openrouter-search'; readonly label = 'OpenRouter Web Search'; readonly sourceType = 'web' as const;
  constructor(private readonly config: OpenRouterSearchConfig, private readonly fetcher: typeof fetch = fetch) {}
  isEnabled(): boolean { return Boolean(this.config.apiKey?.trim() && this.config.webSearch); }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('web'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey || !this.config.webSearch) throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', 'OpenRouter Web Search is not configured', false);
    const response = await this.request(apiKey, plan, signal);
    const message = response.choices[0]!.message;
    let content: unknown; try { content = JSON.parse(message.content.replace(/^```(?:json)?\s*|\s*```$/gi, '')); }
    catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'OpenRouter Web Search returned an invalid response', false); }
    const parsed = resultSchema.safeParse(content);
    if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'OpenRouter Web Search returned an invalid response', false);
    const citations = new Set(message.annotations.flatMap((annotation) => {
      const citation = citationSchema.safeParse(annotation);
      if (!citation.success) return [];
      try { return [canonicalizeUrl(citation.data.url_citation.url)]; } catch { return []; }
    }));
    const candidates: ConnectorResult['candidates'] = [];
    for (const item of parsed.data.results) {
      let url: string; try { url = canonicalizeUrl(item.url); } catch { continue; }
      if (!citations.has(url)) continue;
      candidates.push({
        connectorId: this.id, sourceType: this.sourceType, platform: 'Web', externalId: null,
        url, title: item.title.trim(), content: null, excerpt: item.excerpt?.trim() || null,
        authorName: null, authorHandle: null,
        publishedAt: item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)) ? new Date(item.publishedAt).toISOString() : null,
        language: null, engagement: {}, proof: { kind: 'ai_citation', connectorId: this.id, citationUrl: url },
      });
    }
    return { candidates: candidates.slice(0, plan.maxCandidates), requestCount: 1 };
  }

  private async request(apiKey: string, plan: SourceQueryPlan, parentSignal: AbortSignal): Promise<z.infer<typeof responseSchema>> {
    const controller = new AbortController(); const abort = () => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true }); const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model, temperature: 0.1, max_tokens: 4_096,
          messages: [
            { role: 'system', content: 'Use web search to find substantive recent source pages. Return JSON only with a results array containing url, title, excerpt, and publishedAt. Copy URLs exactly from search sources.' },
            { role: 'user', content: JSON.stringify({ keyword: plan.keyword, queries: plan.queries, windowStart: plan.windowStart, windowEnd: plan.windowEnd }) },
          ],
          plugins: [{ id: 'web' }], provider: { require_parameters: true },
          response_format: { type: 'json_schema', json_schema: { name: 'web_search_results', strict: true,
            schema: { type: 'object', properties: { results: { type: 'array', maxItems: 30, items: { type: 'object', properties: {
              url: { type: 'string', format: 'uri' }, title: { type: 'string' }, excerpt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              publishedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            }, required: ['url', 'title', 'excerpt', 'publishedAt'], additionalProperties: false } } }, required: ['results'], additionalProperties: false } } },
        }),
      });
      if (response.status === 429) throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'OpenRouter Web Search rate limit reached', true);
      if ([401, 402, 403].includes(response.status)) throw new ConnectorError('CONNECTOR_AUTH_FAILED', 'OpenRouter credentials are unavailable', false);
      if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'OpenRouter Web Search is temporarily unavailable', response.status >= 500);
      let payload: unknown; try { payload = await response.json(); } catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'OpenRouter Web Search returned an invalid response', false); }
      const parsed = responseSchema.safeParse(payload); if (!parsed.success) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'OpenRouter Web Search returned an invalid response', false);
      return parsed.data;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'OpenRouter Web Search is temporarily unavailable', true);
    } finally { clearTimeout(timer); parentSignal.removeEventListener('abort', abort); }
  }
}
