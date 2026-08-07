import { parseConfig } from '@lettermate/config';
import { describe, expect, it } from 'vitest';
import { createSourceConnectors, createTrendSources } from './runtime.js';

describe('worker connector runtime', () => {
  it('registers every approved source without requiring optional credentials', () => {
    const connectors = createSourceConnectors(parseConfig({
      AI_API_KEY: 'openrouter-test-key',
    }));

    expect(connectors.map((connector) => connector.id)).toEqual([
      'openrouter-search',
      'twitterapi-io',
      'rss',
      'hacker-news',
      'stack-overflow',
      'arxiv',
      'github',
      'search-brave',
      'search-tavily',
      'search-bing',
      'youtube',
      'reddit',
      'bluesky',
      'bilibili',
    ]);
    expect(connectors.filter((connector) => connector.isEnabled()).map(({ id }) => id)).toEqual([
      'openrouter-search',
      'hacker-news',
      'stack-overflow',
      'arxiv',
      'github',
      'search-bing',
      'bluesky',
      'bilibili',
    ]);
  });

  it('enables TwitterAPI.io and other optional connectors when keys exist', () => {
    const connectors = createSourceConnectors(parseConfig({
      AI_API_KEY: 'openrouter-test-key',
      TWITTERAPI_IO_API_KEY: 'twitter-test-key',
      SEARCH_PROVIDER: 'brave',
      SEARCH_API_KEY: 'search-test-key',
      TAVILY_API_KEY: 'tavily-test-key',
      YOUTUBE_API_KEY: 'youtube-test-key',
      REDDIT_CLIENT_ID: 'reddit-client',
      REDDIT_CLIENT_SECRET: 'reddit-secret',
      DISCOVERY_RSS_FEED_URLS: 'https://example.com/feed.xml',
    }));
    const enabled = new Set(
      connectors.filter((connector) => connector.isEnabled()).map(({ id }) => id),
    );

    expect([...enabled]).toEqual(expect.arrayContaining([
      'twitterapi-io',
      'rss',
      'search-brave',
      'search-tavily',
      'search-bing',
      'youtube',
      'reddit',
    ]));
  });
});

describe('worker trend source runtime', () => {
  it('constructs every trend source while enabling only credential-free defaults', () => {
    const sources = createTrendSources(parseConfig({ TREND_MONITOR_ENABLED: 'false' }));

    expect(sources.map(({ id }) => id)).toEqual([
      'twitter-trends',
      'hacker-news-trends',
      'youtube-trends',
      'reddit-trends',
      'bilibili-trends',
      'google-trends-rss',
    ]);
    expect(sources.filter((source) => source.isEnabled()).map(({ id }) => id)).toEqual([
      'hacker-news-trends',
      'bilibili-trends',
    ]);
  });

  it('uses existing server configuration to enable optional trend sources', () => {
    const sources = createTrendSources(parseConfig({
      TWITTERAPI_IO_API_KEY: 'twitter-key',
      YOUTUBE_API_KEY: 'youtube-key',
      REDDIT_CLIENT_ID: 'reddit-id',
      REDDIT_CLIENT_SECRET: 'reddit-secret',
      TREND_X_WOEIDS: '1,23424977',
      TREND_YOUTUBE_REGION: 'CA',
      TREND_REDDIT_COMMUNITIES: 'programming,technology',
      TREND_GOOGLE_RSS_URLS: 'https://example.com/trends.xml',
    }));

    expect(sources.filter((source) => source.isEnabled()).map(({ id }) => id)).toEqual(
      sources.map(({ id }) => id),
    );
  });
});
