import { Buffer } from 'node:buffer';
import { load } from 'cheerio';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const endpoint = 'https://cn.bing.com/search';
const browserUserAgent = 'Mozilla/5.0';

export interface BingConnectorConfig {
  enabled?: boolean;
  baseUrl?: string;
}

const toHttpUrl = (value: string, baseUrl: string): string | null => {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const decodeBingRedirect = (value: string, baseUrl: string): string | null => {
  const resolved = toHttpUrl(value, baseUrl);
  if (resolved === null) return null;
  const url = new URL(resolved);
  if (!url.hostname.endsWith('.bing.com') && url.hostname !== 'bing.com') return resolved;
  const encoded = url.searchParams.get('u');
  if (!encoded?.startsWith('a1')) return null;
  try {
    const decoded = Buffer.from(encoded.slice(2), 'base64url').toString('utf8');
    return toHttpUrl(decoded, baseUrl);
  } catch {
    return null;
  }
};

const text = (value: string): string | null => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || null;
};

export class BingConnector implements SourceConnector {
  readonly id = 'search-bing';
  readonly label = 'Bing (China)';
  readonly sourceType = 'web' as const;
  private readonly enabled: boolean;
  private readonly baseUrl: string;

  constructor(
    config: BingConnectorConfig = {},
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.enabled = config.enabled ?? true;
    this.baseUrl = config.baseUrl ?? endpoint;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  supports(plan: SourceQueryPlan): boolean {
    return plan.sourceTypes.includes('web');
  }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    if (!this.enabled || plan.maxCandidates <= 0) return { candidates: [], requestCount: 0 };
    const candidates = new Map<string, ConnectorResult['candidates'][number]>();
    let requestCount = 0;
    for (const query of plan.queries) {
      if (candidates.size >= plan.maxCandidates) break;
      const url = new URL(this.baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(50, plan.maxCandidates - candidates.size)));
      url.searchParams.set('setlang', 'zh-Hans');
      url.searchParams.set('cc', 'cn');
      url.searchParams.set('mkt', 'zh-CN');
      const html = await this.request(url, signal);
      requestCount += 1;
      const parsed = this.parseResults(html, url.toString());
      for (const item of parsed) {
        if (candidates.has(item.url)) continue;
        candidates.set(item.url, {
          connectorId: this.id,
          sourceType: this.sourceType,
          platform: this.label,
          externalId: item.url,
          url: item.url,
          title: item.title,
          content: null,
          excerpt: item.excerpt,
          authorName: null,
          authorHandle: null,
          publishedAt: null,
          language: 'zh',
          engagement: {},
          proof: { kind: 'api_record', connectorId: this.id, externalId: item.url },
        });
        if (candidates.size >= plan.maxCandidates) break;
      }
    }
    return { candidates: [...candidates.values()], requestCount };
  }

  private async request(url: URL, signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'user-agent': browserUserAgent,
        },
        signal,
      });
    } catch {
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bing is temporarily unavailable', true);
    }
    if (response.status === 429 || response.status === 403) {
      throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Bing rate limit reached', true);
    }
    if (!response.ok) {
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bing is temporarily unavailable', response.status >= 500);
    }
    try {
      return await response.text();
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bing returned an invalid response', false);
    }
  }

  private parseResults(html: string, baseUrl: string): Array<{ title: string; url: string; excerpt: string | null }> {
    const $ = load(html);
    const items = $('li.b_algo');
    if (items.length === 0) {
      if (/captcha|unusual traffic|verify you are human/i.test(html)) {
        throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Bing rate limit reached', true);
      }
      if ($('#b_results').length === 0) {
        throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bing returned an invalid response', false);
      }
      return [];
    }
    const results: Array<{ title: string; url: string; excerpt: string | null }> = [];
    items.each((_index, element) => {
      const anchor = $(element).find('h2 a').first();
      const title = text(anchor.text());
      const href = anchor.attr('href');
      if (!title || !href) return;
      const url = decodeBingRedirect(href, baseUrl);
      if (url === null) return;
      results.push({
        title,
        url,
        excerpt: text($(element).find('.b_caption p').first().text()),
      });
    });
    return results;
  }
}
