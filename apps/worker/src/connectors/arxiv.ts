import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

const endpoint = 'https://export.arxiv.org/api/query';
const parser = new XMLParser({ attributeNamePrefix: '@_', ignoreAttributes: false, trimValues: true });
type XmlObject = Record<string, unknown>;
const object = (value: unknown): XmlObject | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as XmlObject : null;
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
const entryId = (value: string): string | null => /^https?:\/\/arxiv\.org\/abs\/([^/?#]+)$/i.exec(value)?.[1] ?? null;
const iso = (value: string | null): string | null => value !== null && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export class ArxivConnector implements SourceConnector {
  readonly id = 'arxiv';
  readonly label = 'arXiv';
  readonly sourceType = 'paper' as const;
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  isEnabled(): boolean { return true; }
  supports(plan: SourceQueryPlan): boolean { return plan.sourceTypes.includes('paper'); }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const url = new URL(endpoint);
    url.searchParams.set('search_query', `all:"${(plan.queries[0] ?? plan.keyword).replace(/"/g, '')}"`);
    url.searchParams.set('start', '0');
    url.searchParams.set('max_results', String(Math.min(plan.maxCandidates, 50)));
    let response: Response;
    try { response = await this.fetcher(url.toString(), { signal }); } catch { throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'arXiv is temporarily unavailable', true); }
    if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'arXiv is temporarily unavailable', true);
    let xml: string;
    try { xml = await response.text(); } catch { throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'arXiv returned an invalid response', false); }
    if (XMLValidator.validate(xml) !== true) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'arXiv returned invalid XML', false);
    const feed = object(object(parser.parse(xml))?.feed);
    if (feed === null) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'arXiv returned invalid XML', false);
    const candidates = values(feed.entry).map((value) => this.normalizeEntry(value, url.toString()));
    return { candidates, requestCount: 1 };
  }

  private normalizeEntry(value: unknown, feedUrl: string): ConnectorResult['candidates'][number] {
    const entry = object(value);
    if (entry === null) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'arXiv entry is invalid', false);
    const id = entryId(this.required(string(entry.id), 'arXiv paper ID'));
    const title = string(entry.title);
    const summary = string(entry.summary);
    if (id === null || title === null || summary === null) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'arXiv entry is invalid', false);
    const authors = values(entry.author).map((author) => string(object(author)?.name)).filter((name): name is string => name !== null);
    const links = values(entry.link).map(object);
    const pdf = links.find((link) => string(link?.['@_type']) === 'application/pdf')?.['@_href'];
    const pdfUrl = typeof pdf === 'string' && /^https?:\/\/arxiv\.org\/pdf\//.test(pdf) ? pdf.replace(/^http:/, 'https:') : null;
    return {
      connectorId: this.id, sourceType: this.sourceType, platform: 'arXiv', externalId: id,
      url: `https://arxiv.org/abs/${id}`, title, content: [summary, pdfUrl && `PDF: ${pdfUrl}`].filter(Boolean).join('\n\n'),
      excerpt: null, authorName: authors.join(', ') || null, authorHandle: null,
      publishedAt: iso(string(entry.published) ?? string(entry.updated)), language: 'en', engagement: {},
      proof: { kind: 'feed_entry' as const, connectorId: this.id, feedUrl, entryId: id },
    };
  }
  private required(value: string | null, label: string): string { if (value !== null) return value; throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', `${label} is required`, false); }
}
