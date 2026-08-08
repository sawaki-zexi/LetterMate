import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.url().optional(),
);

const rssFeedUrls = z.preprocess(
  (value) => typeof value === 'string'
    ? value.split(',').map((url) => url.trim()).filter(Boolean)
    : value,
  z.array(z.url()).default([]),
);

const trendWoeids = z.preprocess(
  (value) => typeof value === 'string'
    ? value.split(',').map((woeid) => woeid.trim()).filter(Boolean)
    : value,
  z.array(z.coerce.number().int().positive()).min(1).default([1]),
);

const trendRedditCommunities = z.preprocess(
  (value) => typeof value === 'string'
    ? value.split(',').map((community) => community.trim()).filter(Boolean)
    : value,
  z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).min(1).default([
    'MachineLearning',
    'LocalLLaMA',
    'programming',
    'technology',
  ]),
);

const trendGoogleRssUrls = z.preprocess(
  (value) => typeof value === 'string'
    ? value.split(',').map((url) => url.trim()).filter(Boolean)
    : value,
  z.array(z.url().refine((url) => new URL(url).protocol === 'https:')).default([]),
);

const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1).default('postgresql://lettermate:lettermate@localhost:5432/lettermate'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32).optional(),
  CSRF_SECRET: z.string().min(32).optional(),
  ALLOW_DEV_IDENTITY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  AI_API_KEY: optionalNonEmptyString,
  AI_MODEL: z.string().trim().min(1).default('openrouter/auto'),
  AI_WEB_SEARCH: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(60_000),
  TWITTERAPI_IO_API_KEY: optionalNonEmptyString,
  GITHUB_TOKEN: optionalNonEmptyString,
  YOUTUBE_API_KEY: optionalNonEmptyString,
  REDDIT_CLIENT_ID: optionalNonEmptyString,
  REDDIT_CLIENT_SECRET: optionalNonEmptyString,
  SEARCH_PROVIDER: optionalNonEmptyString,
  SEARCH_API_KEY: optionalNonEmptyString,
  SEARCH_API_BASE_URL: optionalUrl,
  TAVILY_API_KEY: optionalNonEmptyString,
  TAVILY_API_BASE_URL: optionalUrl,
  BING_SEARCH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  BING_SEARCH_BASE_URL: optionalUrl,
  DISCOVERY_RSS_FEED_URLS: rssFeedUrls,
  DISCOVERY_RUN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(900_000)
    .default(600_000),
  DISCOVERY_CONNECTOR_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  DISCOVERY_SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  TREND_MONITOR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  TREND_INTERVAL_HOURS: z.coerce.number().int().min(2).max(24).default(4),
  TREND_X_WOEIDS: trendWoeids,
  TREND_YOUTUBE_REGION: z.string().regex(/^[A-Z]{2}$/).default('US'),
  TREND_REDDIT_COMMUNITIES: trendRedditCommunities,
  TREND_GOOGLE_RSS_URLS: trendGoogleRssUrls,
  SMTP_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_HOST: optionalNonEmptyString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_REQUIRE_TLS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  SMTP_USER: optionalNonEmptyString,
  SMTP_PASSWORD: optionalNonEmptyString,
  SMTP_FROM: optionalNonEmptyString,
  SMTP_MESSAGE_ID_DOMAIN: z.string().trim().regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
  ).default('lettermate.local'),
  SMTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  SMTP_SOCKET_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  RUN_LIVE_AI_TESTS: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1'),
  RUN_LIVE_EMAIL_TESTS: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1'),
  SMTP_SMOKE_RECIPIENT: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.email().optional(),
  ),
});

export type AppConfig = z.infer<typeof baseConfigSchema>;

export function parseConfig(environment: Record<string, string | undefined>): AppConfig {
  const parsed = baseConfigSchema.parse(environment);

  if (parsed.SMTP_ENABLED) {
    const missing = [
      ['SMTP_HOST', parsed.SMTP_HOST],
      ['SMTP_FROM', parsed.SMTP_FROM],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Missing required SMTP configuration: ${missing.join(', ')}`);
    }
    if (Boolean(parsed.SMTP_USER) !== Boolean(parsed.SMTP_PASSWORD)) {
      throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
    }
  }

  if (parsed.NODE_ENV === 'production') {
    const missing = ['SESSION_SECRET', 'CSRF_SECRET'].filter(
      (name) => !parsed[name as keyof AppConfig],
    );
    if (missing.length > 0) {
      throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
    }
    if (parsed.ALLOW_DEV_IDENTITY) {
      throw new Error('ALLOW_DEV_IDENTITY must be false in production');
    }
  }

  return parsed;
}
