import { describe, expect, it } from 'vitest';
import { parseConfig } from './index.js';

describe('configuration', () => {
  it('requires secrets in production', () => {
    expect(() =>
      parseConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://db/app' }),
    ).toThrow(/SESSION_SECRET/);
  });

  it('provides safe local service defaults', () => {
    expect(parseConfig({ NODE_ENV: 'development' })).toMatchObject({
      PORT: 3000,
      WEB_ORIGIN: 'http://localhost:5173',
    });
  });

  it('provides bounded discovery execution defaults', () => {
    expect(parseConfig({})).toMatchObject({
      DISCOVERY_RUN_TIMEOUT_MS: 600_000,
      DISCOVERY_CONNECTOR_CONCURRENCY: 4,
      DISCOVERY_SCHEDULER_ENABLED: true,
    });
  });

  it('provides safe trend monitor defaults', () => {
    expect(parseConfig({})).toMatchObject({
      TREND_MONITOR_ENABLED: true,
      TREND_INTERVAL_HOURS: 4,
      TREND_X_WOEIDS: [1],
      TREND_YOUTUBE_REGION: 'US',
      TREND_REDDIT_COMMUNITIES: [
        'MachineLearning',
        'LocalLLaMA',
        'programming',
        'technology',
      ],
      TREND_GOOGLE_RSS_URLS: [],
    });
  });

  it('parses explicit trend monitor configuration', () => {
    expect(parseConfig({
      TREND_MONITOR_ENABLED: 'false',
      TREND_INTERVAL_HOURS: '12',
      TREND_X_WOEIDS: '1, 23424977',
      TREND_YOUTUBE_REGION: 'CA',
      TREND_REDDIT_COMMUNITIES: 'MachineLearning, tech-news, local_ai',
      TREND_GOOGLE_RSS_URLS: 'https://example.com/trends.xml, https://example.org/rss',
    })).toMatchObject({
      TREND_MONITOR_ENABLED: false,
      TREND_INTERVAL_HOURS: 12,
      TREND_X_WOEIDS: [1, 23424977],
      TREND_YOUTUBE_REGION: 'CA',
      TREND_REDDIT_COMMUNITIES: ['MachineLearning', 'tech-news', 'local_ai'],
      TREND_GOOGLE_RSS_URLS: [
        'https://example.com/trends.xml',
        'https://example.org/rss',
      ],
    });
  });

  it('rejects trend intervals outside the configured bounds', () => {
    expect(() => parseConfig({ TREND_INTERVAL_HOURS: '1' })).toThrow();
    expect(() => parseConfig({ TREND_INTERVAL_HOURS: '25' })).toThrow();
  });

  it.each(['0', '-1', '1.5', 'worldwide', '1,0'])('rejects invalid trend WOEIDs: %s', (value) => {
    expect(() => parseConfig({ TREND_X_WOEIDS: value })).toThrow();
  });

  it.each(['us', 'USA', 'U1', ' U S '])('rejects invalid YouTube region codes: %s', (value) => {
    expect(() => parseConfig({ TREND_YOUTUBE_REGION: value })).toThrow();
  });

  it('rejects Reddit community paths', () => {
    expect(() => parseConfig({ TREND_REDDIT_COMMUNITIES: 'r/programming' })).toThrow();
    expect(() => parseConfig({ TREND_REDDIT_COMMUNITIES: 'programming/news' })).toThrow();
  });

  it('rejects non-HTTPS trend RSS URLs', () => {
    expect(() => parseConfig({ TREND_GOOGLE_RSS_URLS: 'http://example.com/trends.xml' })).toThrow();
    expect(() => parseConfig({ TREND_GOOGLE_RSS_URLS: 'ftp://example.com/trends.xml' })).toThrow();
  });

  it('defaults to OpenRouter auto routing and web search', () => {
    expect(parseConfig({ NODE_ENV: 'development', AI_API_KEY: 'secret' })).toMatchObject({
      AI_API_KEY: 'secret',
      AI_MODEL: 'openrouter/auto',
      AI_WEB_SEARCH: true,
      AI_TIMEOUT_MS: 60_000,
    });
  });

  it('allows selecting another OpenRouter model without code changes', () => {
    expect(
      parseConfig({ AI_API_KEY: 'secret', AI_MODEL: 'openai/gpt-4.1-mini' }).AI_MODEL,
    ).toBe('openai/gpt-4.1-mini');
  });

  it('treats an empty example Key as not configured', () => {
    expect(parseConfig({ AI_API_KEY: '' }).AI_API_KEY).toBeUndefined();
  });

  it('rejects ambiguous web search configuration', () => {
    expect(() => parseConfig({ AI_WEB_SEARCH: 'yes' })).toThrow();
  });

  it('accepts optional connector configuration', () => {
    expect(
      parseConfig({
        TWITTERAPI_IO_API_KEY: 'x-key',
        GITHUB_TOKEN: 'github-token',
        YOUTUBE_API_KEY: 'youtube-key',
        REDDIT_CLIENT_ID: 'reddit-client',
        REDDIT_CLIENT_SECRET: 'reddit-secret',
        SEARCH_PROVIDER: 'search-provider',
        SEARCH_API_KEY: 'search-key',
        SEARCH_API_BASE_URL: 'https://search.example.com/v1',
      }),
    ).toMatchObject({
      TWITTERAPI_IO_API_KEY: 'x-key',
      GITHUB_TOKEN: 'github-token',
      YOUTUBE_API_KEY: 'youtube-key',
      REDDIT_CLIENT_ID: 'reddit-client',
      REDDIT_CLIENT_SECRET: 'reddit-secret',
      SEARCH_PROVIDER: 'search-provider',
      SEARCH_API_KEY: 'search-key',
      SEARCH_API_BASE_URL: 'https://search.example.com/v1',
    });
  });

  it('parses and validates configured RSS feed URLs', () => {
    expect(parseConfig({
      DISCOVERY_RSS_FEED_URLS: 'https://example.com/feed.xml, https://example.org/rss',
    }).DISCOVERY_RSS_FEED_URLS).toEqual([
      'https://example.com/feed.xml',
      'https://example.org/rss',
    ]);
    expect(() => parseConfig({
      DISCOVERY_RSS_FEED_URLS: 'https://example.com/feed.xml,not-a-url',
    })).toThrow();
  });

  it('treats empty optional connector configuration as absent', () => {
    expect(
      parseConfig({
        TWITTERAPI_IO_API_KEY: '',
        SEARCH_API_BASE_URL: '',
      }),
    ).toMatchObject({
      TWITTERAPI_IO_API_KEY: undefined,
      SEARCH_API_BASE_URL: undefined,
    });
  });

  it('validates discovery execution bounds and search URLs', () => {
    expect(() => parseConfig({ DISCOVERY_RUN_TIMEOUT_MS: '59999' })).toThrow();
    expect(() => parseConfig({ DISCOVERY_RUN_TIMEOUT_MS: '900001' })).toThrow();
    expect(() => parseConfig({ DISCOVERY_CONNECTOR_CONCURRENCY: '0' })).toThrow();
    expect(() => parseConfig({ DISCOVERY_CONNECTOR_CONCURRENCY: '17' })).toThrow();
    expect(() => parseConfig({ SEARCH_API_BASE_URL: 'not-a-url' })).toThrow();
  });

  it('parses an explicitly disabled discovery scheduler', () => {
    expect(parseConfig({ DISCOVERY_SCHEDULER_ENABLED: 'false' }).DISCOVERY_SCHEDULER_ENABLED).toBe(
      false,
    );
  });

  it('does not require optional connector keys in production', () => {
    expect(() =>
      parseConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 's'.repeat(32),
        CSRF_SECRET: 'c'.repeat(32),
      }),
    ).not.toThrow();
  });
});
