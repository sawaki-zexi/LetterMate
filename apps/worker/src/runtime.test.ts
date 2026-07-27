import { parseConfig } from '@lettermate/config';
import { describe, expect, it } from 'vitest';
import { createSourceConnectors } from './runtime.js';

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
      'arxiv',
      'github',
      'search-brave',
      'youtube',
      'reddit',
      'bluesky',
      'bilibili',
    ]);
    expect(connectors.filter((connector) => connector.isEnabled()).map(({ id }) => id)).toEqual([
      'openrouter-search',
      'hacker-news',
      'arxiv',
      'github',
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
      YOUTUBE_API_KEY: 'youtube-test-key',
      REDDIT_CLIENT_ID: 'reddit-client',
      REDDIT_CLIENT_SECRET: 'reddit-secret',
    }));
    const enabled = new Set(
      connectors.filter((connector) => connector.isEnabled()).map(({ id }) => id),
    );

    expect([...enabled]).toEqual(expect.arrayContaining([
      'twitterapi-io',
      'search-brave',
      'youtube',
      'reddit',
    ]));
  });
});
