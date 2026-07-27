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
