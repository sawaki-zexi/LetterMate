import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

export interface ParsedCollectedItem {
  title: string;
  url: string;
  body: string;
  publishedAt: string;
}

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

function textFromHtml(value: unknown): string {
  if (typeof value !== 'string') return '';
  return normalizeText(load(value).text());
}

export function parseRssFeed(xml: string): ParsedCollectedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const document = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown | unknown[] } };
    feed?: { entry?: unknown | unknown[] };
  };
  const rawItems = document.rss?.channel?.item ?? document.feed?.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === 'string' ? normalizeText(item.title) : '';
    const rawLink = item.link;
    const url = typeof rawLink === 'string'
      ? rawLink
      : rawLink && typeof rawLink === 'object' && '@_href' in rawLink
        ? String((rawLink as Record<string, unknown>)['@_href'])
        : '';
    const rawDate = item.pubDate ?? item.published ?? item.updated;
    const date = new Date(String(rawDate ?? ''));
    if (!title || !URL.canParse(url) || Number.isNaN(date.valueOf())) return [];
    const body = textFromHtml(item['content:encoded'] ?? item.content ?? item.description ?? item.summary);
    return [{ title, url, body, publishedAt: date.toISOString() }];
  });
}

export function parseHtmlArticle(requestUrl: string, html: string): ParsedCollectedItem {
  const $ = load(html);
  const title = normalizeText(
    $('meta[property="og:title"]').attr('content') ?? $('article h1').first().text() ?? $('title').text(),
  );
  const canonicalHref = $('link[rel="canonical"]').attr('href');
  const url = canonicalHref ? new URL(canonicalHref, requestUrl).href : requestUrl;
  const publishedValue =
    $('meta[property="article:published_time"]').attr('content') ??
    $('time[datetime]').first().attr('datetime');
  const publishedAt = new Date(publishedValue ?? '').toISOString();
  const article = $('article').first();
  article.find('script, style, nav, aside').remove();
  const blocks = article.find('h1, h2, h3, p, li, blockquote').map((_index, element) => $(element).text()).get();
  const body = normalizeText(blocks.length > 0 ? blocks.join(' ') : article.length > 0 ? article.text() : $('main').first().text());
  if (!title || !body) throw new Error('Article title and body are required');
  return { title, url, body, publishedAt };
}
