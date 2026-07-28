import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ContentFetchError, ContentFetcher } from '../content-fetcher.js';
import { TrendSourceError, type TrendSeedCandidate, type TrendSource, type TrendSourceResult, type TrendWindow } from './types.js';

type XmlObject = Record<string, unknown>;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  processEntities: false,
});
const asObject = (value: unknown): XmlObject | null => typeof value === 'object' && value !== null && !Array.isArray(value)
  ? value as XmlObject : null;
const asArray = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const asText = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  const object = asObject(value);
  if (!object) return null;
  for (const key of ['#text', '@_href']) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  }
  return null;
};
const safeHttpUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
};
const normalizedIdentityTitle = (value: string): string => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const geoFromUrl = (value: string): string | null => {
  try {
    const geo = new URL(value).searchParams.get('geo')?.trim().toUpperCase() ?? '';
    return /^[A-Z]{2}$/.test(geo) ? geo : null;
  } catch { return null; }
};
const isoDate = (value: string | null): string | null => {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

export interface GoogleRssTrendSourceConfig {
  feedUrls: string[];
  maxEntriesPerFeed?: number;
}

export class GoogleRssTrendSource implements TrendSource {
  readonly id = 'google-trends-rss';
  readonly label = 'Google Trends';
  readonly minimumRequestBudget = 1;
  private readonly feedUrls: string[];
  private readonly maxEntriesPerFeed: number;

  constructor(
    config: GoogleRssTrendSourceConfig,
    private readonly textFetcher: Pick<ContentFetcher, 'fetchRawText'> = new ContentFetcher({ maxBytes: 512_000 }),
  ) {
    this.feedUrls = config.feedUrls.map((value) => {
      try {
        const url = new URL(value);
        if (url.protocol === 'https:') return url.toString();
      } catch { /* Validated below. */ }
      throw new Error('Google Trends RSS feeds must use HTTPS');
    });
    this.maxEntriesPerFeed = config.maxEntriesPerFeed ?? 30;
    if (!Number.isInteger(this.maxEntriesPerFeed) || this.maxEntriesPerFeed < 1 || this.maxEntriesPerFeed > 100) {
      throw new Error('maxEntriesPerFeed must be an integer from 1 to 100');
    }
  }

  isEnabled(): boolean { return this.feedUrls.length > 0; }

  async collect(window: TrendWindow, signal: AbortSignal): Promise<TrendSourceResult> {
    const candidates: TrendSeedCandidate[] = [];
    let requestCount = 0;
    for (const feedUrl of this.feedUrls.slice(0, window.requestBudget)) {
      if (candidates.length >= window.maxCandidates) break;
      const fetched = await this.request(feedUrl, signal, window.recordRequest);
      requestCount += fetched.requestCount;
      candidates.push(...this.parse(fetched.xml, feedUrl, Math.min(
        this.maxEntriesPerFeed,
        window.maxCandidates - candidates.length,
      )));
    }
    return { candidates, requestCount };
  }

  private async request(
    url: string,
    signal: AbortSignal,
    recordRegistryRequest?: () => void,
  ): Promise<{ xml: string; requestCount: number }> {
    let requestCount = 0;
    try {
      const fetched = await this.textFetcher.fetchRawText(url, {
        signal,
        acceptedContentTypes: [
          'application/rss+xml',
          'application/atom+xml',
          'application/xml',
          'text/xml',
        ],
        onRequest: () => {
          recordRegistryRequest?.();
          requestCount += 1;
        },
      });
      return { xml: fetched.text, requestCount };
    } catch (error) {
      if (signal.aborted || (error instanceof ContentFetchError && error.code === 'CONTENT_FETCH_ABORTED')) {
        throw new TrendSourceError('TREND_SOURCE_ABORTED', 'Google Trends RSS collection was aborted', true);
      }
      if (error instanceof ContentFetchError && error.status === 429) {
        throw new TrendSourceError('TREND_SOURCE_RATE_LIMITED', 'Google Trends RSS rate limit reached', true);
      }
      if (error instanceof ContentFetchError && [
        'UNSAFE_SOURCE_URL',
        'UNSUPPORTED_CONTENT_TYPE',
        'CONTENT_TOO_LARGE',
      ].includes(error.code)) {
        throw new TrendSourceError('TREND_SOURCE_RESPONSE_INVALID', 'Google Trends RSS returned an invalid response', false);
      }
      throw new TrendSourceError('TREND_SOURCE_UNAVAILABLE', 'Google Trends RSS is temporarily unavailable', true);
    }
  }

  private parse(xml: string, feedUrl: string, limit: number): TrendSeedCandidate[] {
    if (XMLValidator.validate(xml) !== true) throw this.invalidXml();
    let document: XmlObject;
    try {
      const parsed = asObject(parser.parse(xml));
      if (!parsed) throw new Error('invalid root');
      document = parsed;
    } catch { throw this.invalidXml(); }
    const rss = asObject(document.rss);
    const channel = rss ? asObject(rss.channel) : null;
    if (!channel) throw new TrendSourceError('TREND_SOURCE_RESPONSE_INVALID', 'Google Trends RSS format is not supported', false);
    const candidates: TrendSeedCandidate[] = [];
    for (const rawItem of asArray(channel.item).slice(0, this.maxEntriesPerFeed)) {
      const item = asObject(rawItem);
      if (!item) continue;
      const title = asText(item.title);
      const rawLink = asText(item.link);
      if (!title || !rawLink) continue;
      const itemLink = safeHttpUrl(rawLink);
      if (!itemLink) continue;
      const geo = geoFromUrl(feedUrl) ?? geoFromUrl(itemLink);
      const exploreUrl = new URL('https://trends.google.com/trends/explore');
      exploreUrl.searchParams.set('q', title);
      if (geo) exploreUrl.searchParams.set('geo', geo);
      candidates.push({
        sourceId: this.id,
        platform: this.label,
        externalId: asText(item.guid) ?? `${geo ?? 'GLOBAL'}:${normalizedIdentityTitle(title)}`,
        title,
        url: exploreUrl.toString(),
        publishedAt: isoDate(asText(item.pubDate) ?? asText(item.published) ?? asText(item.date)),
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }

  private invalidXml(): TrendSourceError {
    return new TrendSourceError('TREND_SOURCE_RESPONSE_INVALID', 'Google Trends RSS returned invalid XML', false);
  }
}
