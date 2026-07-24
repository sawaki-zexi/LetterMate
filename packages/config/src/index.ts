import { z } from 'zod';

const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1).default('postgresql://lettermate:lettermate@localhost:5432/lettermate'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32).optional(),
  CSRF_SECRET: z.string().min(32).optional(),
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
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
