import type { AppConfig } from '@lettermate/config';
import { ArxivConnector } from './connectors/arxiv.js';
import { BilibiliConnector } from './connectors/bilibili.js';
import { BlueskyConnector } from './connectors/bluesky.js';
import { GitHubConnector } from './connectors/github.js';
import { HackerNewsConnector } from './connectors/hacker-news.js';
import { OpenRouterSearchConnector } from './connectors/openrouter-search.js';
import { RedditConnector } from './connectors/reddit.js';
import { RssConnector } from './connectors/rss.js';
import { SearchProviderConnector } from './connectors/search-provider.js';
import { TwitterApiIoConnector } from './connectors/twitterapi-io.js';
import type { SourceConnector } from './connectors/types.js';
import { YouTubeConnector } from './connectors/youtube.js';

export function createSourceConnectors(
  config: AppConfig,
  fetcher: typeof fetch = fetch,
): SourceConnector[] {
  return [
    new OpenRouterSearchConnector({
      apiKey: config.AI_API_KEY,
      model: config.AI_MODEL,
      webSearch: config.AI_WEB_SEARCH,
      timeoutMs: config.AI_TIMEOUT_MS,
    }, fetcher),
    new TwitterApiIoConnector({ apiKey: config.TWITTERAPI_IO_API_KEY }, fetcher),
    new RssConnector({ feedUrls: [] }, fetcher),
    new HackerNewsConnector(fetcher),
    new ArxivConnector(fetcher),
    new GitHubConnector({ token: config.GITHUB_TOKEN }, fetcher),
    new SearchProviderConnector({
      provider: 'brave',
      apiKey: config.SEARCH_PROVIDER === 'brave' ? config.SEARCH_API_KEY : undefined,
      ...(config.SEARCH_API_BASE_URL ? { baseUrl: config.SEARCH_API_BASE_URL } : {}),
    }, fetcher),
    new YouTubeConnector({ apiKey: config.YOUTUBE_API_KEY }, fetcher),
    new RedditConnector({
      clientId: config.REDDIT_CLIENT_ID,
      clientSecret: config.REDDIT_CLIENT_SECRET,
    }, fetcher),
    new BlueskyConnector(fetcher),
    new BilibiliConnector({}, fetcher),
  ];
}
