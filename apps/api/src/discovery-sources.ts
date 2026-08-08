import type { AppConfig } from '@lettermate/config';
import {
  discoverySourceStatusSchema,
  type DiscoverySourceStatus,
} from '@lettermate/contracts';

export function configuredDiscoverySources(config: AppConfig): DiscoverySourceStatus[] {
  const status = (enabled: boolean) => enabled ? 'enabled' as const : 'not_configured' as const;
  return discoverySourceStatusSchema.array().parse([
    {
      id: 'openrouter-search',
      label: 'OpenRouter Web Search',
      category: 'web',
      status: status(Boolean(config.AI_API_KEY && config.AI_WEB_SEARCH)),
    },
    {
      id: 'twitterapi-io',
      label: 'X',
      category: 'social',
      status: status(Boolean(config.TWITTERAPI_IO_API_KEY)),
    },
    {
      id: 'rss',
      label: 'RSS/Atom',
      category: 'feed',
      status: status(config.DISCOVERY_RSS_FEED_URLS.length > 0),
    },
    { id: 'hacker-news', label: 'Hacker News', category: 'community', status: 'enabled' },
    { id: 'stack-overflow', label: 'Stack Overflow', category: 'community', status: 'enabled' },
    { id: 'arxiv', label: 'arXiv', category: 'paper', status: 'enabled' },
    { id: 'github', label: 'GitHub', category: 'code', status: 'enabled' },
    {
      id: 'search-brave',
      label: 'Brave Search',
      category: 'web',
      status: status(config.SEARCH_PROVIDER === 'brave' && Boolean(config.SEARCH_API_KEY)),
    },
    {
      id: 'search-tavily',
      label: 'Tavily',
      category: 'web',
      status: status(Boolean(config.TAVILY_API_KEY)),
    },
    {
      id: 'search-bing',
      label: 'Bing (China)',
      category: 'web',
      status: status(config.BING_SEARCH_ENABLED),
    },
    {
      id: 'youtube',
      label: 'YouTube',
      category: 'video',
      status: status(Boolean(config.YOUTUBE_API_KEY)),
    },
    {
      id: 'reddit',
      label: 'Reddit',
      category: 'community',
      status: status(Boolean(config.REDDIT_CLIENT_ID && config.REDDIT_CLIENT_SECRET)),
    },
    { id: 'bluesky', label: 'Bluesky', category: 'social', status: 'enabled' },
    { id: 'bilibili', label: 'Bilibili', category: 'video', status: 'enabled' },
    {
      id: 'twitter-trends', label: 'X Trends', category: 'social',
      status: status(Boolean(config.TWITTERAPI_IO_API_KEY)),
    },
    {
      id: 'hacker-news-trends', label: 'Hacker News Top Stories',
      category: 'community', status: 'enabled',
    },
    {
      id: 'youtube-trends', label: 'YouTube Most Popular', category: 'video',
      status: status(Boolean(config.YOUTUBE_API_KEY)),
    },
    {
      id: 'reddit-trends', label: 'Reddit Hot', category: 'community',
      status: status(Boolean(config.REDDIT_CLIENT_ID && config.REDDIT_CLIENT_SECRET)),
    },
    { id: 'bilibili-trends', label: 'Bilibili Popular', category: 'video', status: 'enabled' },
    {
      id: 'google-trends-rss', label: 'Google Trends RSS', category: 'feed',
      status: status(config.TREND_GOOGLE_RSS_URLS.length > 0),
    },
  ]);
}
