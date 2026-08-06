import type { AppConfig } from '@lettermate/config';
import { ContentFetcher } from './content-fetcher.js';
import { ArxivConnector } from './connectors/arxiv.js';
import { BingConnector } from './connectors/bing.js';
import { BilibiliConnector } from './connectors/bilibili.js';
import { BlueskyConnector } from './connectors/bluesky.js';
import { GitHubConnector } from './connectors/github.js';
import { HackerNewsConnector } from './connectors/hacker-news.js';
import { OpenRouterSearchConnector } from './connectors/openrouter-search.js';
import { RedditConnector } from './connectors/reddit.js';
import { RssConnector } from './connectors/rss.js';
import { TavilyConnector } from './connectors/tavily.js';
import { SearchProviderConnector } from './connectors/search-provider.js';
import { TwitterApiIoConnector } from './connectors/twitterapi-io.js';
import type { SourceConnector } from './connectors/types.js';
import { YouTubeConnector } from './connectors/youtube.js';
import { BilibiliTrendSource } from './trends/bilibili.js';
import { GoogleRssTrendSource } from './trends/google-rss.js';
import { HackerNewsTrendSource } from './trends/hacker-news.js';
import { RedditTrendSource } from './trends/reddit.js';
import { TwitterApiIoTrendSource } from './trends/twitterapi-io.js';
import type { TrendSource } from './trends/types.js';
import { YouTubeTrendSource } from './trends/youtube.js';

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
    new RssConnector({ feedUrls: config.DISCOVERY_RSS_FEED_URLS }, fetcher),
    new HackerNewsConnector(fetcher),
    new ArxivConnector(fetcher),
    new GitHubConnector({ token: config.GITHUB_TOKEN }, fetcher),
    new SearchProviderConnector({
      provider: 'brave',
      apiKey: config.SEARCH_PROVIDER === 'brave' ? config.SEARCH_API_KEY : undefined,
      ...(config.SEARCH_API_BASE_URL ? { baseUrl: config.SEARCH_API_BASE_URL } : {}),
    }, fetcher),
    new TavilyConnector({
      apiKey: config.TAVILY_API_KEY,
      ...(config.TAVILY_API_BASE_URL ? { baseUrl: config.TAVILY_API_BASE_URL } : {}),
    }, fetcher),
    new BingConnector({
      enabled: config.BING_SEARCH_ENABLED,
      ...(config.BING_SEARCH_BASE_URL ? { baseUrl: config.BING_SEARCH_BASE_URL } : {}),
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

export function createTrendSources(
  config: AppConfig,
  fetcher: typeof fetch = fetch,
): TrendSource[] {
  return [
    new TwitterApiIoTrendSource({
      apiKey: config.TWITTERAPI_IO_API_KEY,
      woeids: config.TREND_X_WOEIDS,
    }, fetcher),
    new HackerNewsTrendSource(fetcher),
    new YouTubeTrendSource({
      apiKey: config.YOUTUBE_API_KEY,
      region: config.TREND_YOUTUBE_REGION,
    }, fetcher),
    new RedditTrendSource({
      clientId: config.REDDIT_CLIENT_ID,
      clientSecret: config.REDDIT_CLIENT_SECRET,
      communities: config.TREND_REDDIT_COMMUNITIES,
    }, fetcher),
    new BilibiliTrendSource({}, fetcher),
    new GoogleRssTrendSource(
      { feedUrls: config.TREND_GOOGLE_RSS_URLS },
      new ContentFetcher({}, fetcher),
    ),
  ];
}
