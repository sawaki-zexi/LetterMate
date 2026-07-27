import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.url().optional(),
);

const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1).default('postgresql://lettermate:lettermate@localhost:5432/lettermate'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32).optional(),
  CSRF_SECRET: z.string().min(32).optional(),
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
  RUN_LIVE_AI_TESTS: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1'),
});

export type AppConfig = z.infer<typeof baseConfigSchema>;

export function parseConfig(environment: Record<string, string | undefined>): AppConfig {
  const parsed = baseConfigSchema.parse(environment);

  if (parsed.NODE_ENV === 'production') {
    const missing = ['SESSION_SECRET', 'CSRF_SECRET'].filter(
      (name) => !parsed[name as keyof AppConfig],
    );
    if (missing.length > 0) {
      throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
    }
  }

  return parsed;
}
