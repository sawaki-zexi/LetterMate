import { describe, expect, it } from 'vitest';
import { parseHtmlArticle, parseRssFeed } from './collectors.js';

describe('RSS collector adapter', () => {
  it('normalizes feed entries into collected items', () => {
    const items = parseRssFeed(`<?xml version="1.0"?><rss><channel><item>
      <title>Agent Studio released</title>
      <link>https://example.com/release?utm_source=rss</link>
      <pubDate>Fri, 24 Jul 2026 06:30:00 GMT</pubDate>
      <description>Official release details</description>
    </item></channel></rss>`);

    expect(items).toEqual([expect.objectContaining({
      title: 'Agent Studio released',
      url: 'https://example.com/release?utm_source=rss',
      body: 'Official release details',
      publishedAt: '2026-07-24T06:30:00.000Z',
    })]);
  });
});

describe('HTML collector adapter', () => {
  it('uses canonical metadata and extracts readable article text', () => {
    const item = parseHtmlArticle('https://example.com/news?id=42', `
      <html><head><title>Fallback title</title><link rel="canonical" href="https://example.com/news/agent" />
      <meta property="og:title" content="Agent release" /><meta property="article:published_time" content="2026-07-24T07:00:00Z" /></head>
      <body><nav>Navigation</nav><article><h1>Agent release</h1><p>Detailed evidence.</p></article></body></html>`);

    expect(item).toEqual({
      title: 'Agent release',
      url: 'https://example.com/news/agent',
      body: 'Agent release Detailed evidence.',
      publishedAt: '2026-07-24T07:00:00.000Z',
    });
  });
});
