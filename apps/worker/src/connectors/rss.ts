import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ConnectorError, type ConnectorResult, type SourceConnector, type SourceQueryPlan } from './types.js';

type XmlObject = Record<string, unknown>;

export interface RssConnectorConfig {
  feedUrls: string[];
  maxEntriesPerFeed?: number;
}

const parser = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  trimValues: true,
});

const asObject = (value: unknown): XmlObject | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as XmlObject
    : null
);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

const asString = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

const htmlToText = (value: string | null): string | null => {
  if (value === null) return null;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  return text || null;
};

const toHttpUrl = (value: string, label: string): string => {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // Mapped to a safe connector response below.
  }
  throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', `${label} must use HTTP or HTTPS`, false);
};

const toIsoTime = (value: string | null): string | null => {
  if (value === null) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

const authorFromRss = (value: string | null): string | null => {
  if (value === null) return null;
  const parenthesized = /\(([^)]+)\)/.exec(value)?.[1]?.trim();
  return parenthesized || value.replace(/^[^\s@]+@[^\s@]+\s*/, '').trim() || null;
};

const atomLink = (entry: XmlObject): string | null => {
  for (const link of asArray(entry.link)) {
    const linkObject = asObject(link);
    if (linkObject === null) continue;
    const rel = asString(linkObject['@_rel']);
    const href = asString(linkObject['@_href']);
    if ((rel === null || rel === 'alternate') && href !== null) return href;
  }
  return null;
};

export class RssConnector implements SourceConnector {
  readonly id = 'rss';
  readonly label = 'RSS/Atom';
  readonly sourceType = 'feed' as const;
  private readonly feedUrls: string[];
  private readonly maxEntriesPerFeed: number;

  constructor(
    config: RssConnectorConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.feedUrls = config.feedUrls.map((url) => toHttpUrl(url, 'Feed URL'));
    this.maxEntriesPerFeed = config.maxEntriesPerFeed ?? 20;
    if (!Number.isInteger(this.maxEntriesPerFeed) || this.maxEntriesPerFeed < 1) {
      throw new Error('maxEntriesPerFeed must be a positive integer');
    }
  }

  isEnabled(): boolean {
    return this.feedUrls.length > 0;
  }

  supports(plan: SourceQueryPlan): boolean {
    return plan.sourceTypes.includes('feed');
  }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const candidates: ConnectorResult['candidates'] = [];
    let requestCount = 0;
    for (const feedUrl of this.feedUrls) {
      if (candidates.length >= plan.maxCandidates) break;
      const xml = await this.fetchFeed(feedUrl, signal);
      requestCount += 1;
      candidates.push(...this.parseFeed(xml, feedUrl, plan.maxCandidates - candidates.length));
    }
    return { candidates, requestCount };
  }

  private async fetchFeed(feedUrl: string, signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(feedUrl, { signal });
    } catch {
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'RSS feed is temporarily unavailable', true);
    }
    if (!response.ok) {
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'RSS feed is temporarily unavailable', true);
    }
    try {
      return await response.text();
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'RSS feed returned an invalid response', false);
    }
  }

  private parseFeed(xml: string, feedUrl: string, limit: number): ConnectorResult['candidates'] {
    if (XMLValidator.validate(xml) !== true) {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'RSS feed returned invalid XML', false);
    }
    let parsed: XmlObject;
    try {
      const result = asObject(parser.parse(xml));
      if (result === null) throw new Error('not an object');
      parsed = result;
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'RSS feed returned invalid XML', false);
    }
    const rss = asObject(parsed.rss);
    const channel = rss === null ? null : asObject(rss.channel);
    if (channel !== null) return this.parseRssItems(channel, feedUrl, limit);
    const atom = asObject(parsed.feed);
    if (atom !== null) return this.parseAtomEntries(atom, feedUrl, limit);
    throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'RSS feed format is not supported', false);
  }

  private parseRssItems(channel: XmlObject, feedUrl: string, limit: number): ConnectorResult['candidates'] {
    const platform = asString(channel.title) ?? new URL(feedUrl).host;
    return asArray(channel.item).slice(0, limit).map((item) => {
      const entry = asObject(item);
      if (entry === null) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'RSS entry is invalid', false);
      const url = toHttpUrl(this.requiredString(entry.link, 'RSS entry link'), 'RSS entry link');
      const externalId = asString(entry.guid) ?? url;
      const title = asString(entry.title);
      return {
        connectorId: this.id,
        sourceType: this.sourceType,
        platform,
        externalId,
        url,
        title,
        content: htmlToText(asString(entry['content:encoded']) ?? asString(entry.description)),
        excerpt: null,
        authorName: authorFromRss(asString(entry.author) ?? asString(entry.creator)),
        authorHandle: null,
        publishedAt: toIsoTime(asString(entry.pubDate) ?? asString(entry.date)),
        language: asString(channel.language),
        engagement: {},
        proof: { kind: 'feed_entry' as const, connectorId: this.id, feedUrl, entryId: externalId },
      };
    });
  }

  private parseAtomEntries(feed: XmlObject, feedUrl: string, limit: number): ConnectorResult['candidates'] {
    const platform = asString(feed.title) ?? new URL(feedUrl).host;
    return asArray(feed.entry).slice(0, limit).map((item) => {
      const entry = asObject(item);
      if (entry === null) throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Atom entry is invalid', false);
      const url = toHttpUrl(this.requiredString(atomLink(entry), 'Atom entry link'), 'Atom entry link');
      const externalId = this.requiredString(asString(entry.id), 'Atom entry ID');
      const author = asObject(asArray(entry.author)[0]);
      return {
        connectorId: this.id,
        sourceType: this.sourceType,
        platform,
        externalId,
        url,
        title: asString(entry.title),
        content: htmlToText(asString(entry.content) ?? asString(entry.summary)),
        excerpt: null,
        authorName: author === null ? null : asString(author.name),
        authorHandle: null,
        publishedAt: toIsoTime(asString(entry.published) ?? asString(entry.updated)),
        language: asString(feed['xml:lang']),
        engagement: {},
        proof: { kind: 'feed_entry' as const, connectorId: this.id, feedUrl, entryId: externalId },
      };
    });
  }

  private requiredString(value: string | null, label: string): string {
    if (value !== null) return value;
    throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', `${label} is required`, false);
  }
}
