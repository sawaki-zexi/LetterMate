import {
  readinessSchema,
  type HealthDependency,
  type Readiness,
} from '@lettermate/contracts';

export interface HealthProbe {
  check(): Promise<void>;
}

export interface ApiHealthChecks {
  database?: HealthProbe;
  redis?: HealthProbe;
  aiConfigured: boolean;
}

const unavailableCode = (dependency: string): string => {
  if (dependency === 'database') return 'DATABASE_UNAVAILABLE';
  if (dependency === 'redis') return 'REDIS_UNAVAILABLE';
  return 'DEPENDENCY_UNAVAILABLE';
};

async function probe(
  dependency: 'database' | 'redis',
  healthProbe: HealthProbe | undefined,
): Promise<HealthDependency> {
  if (!healthProbe) return { status: 'not_configured', code: 'HEALTH_CHECK_NOT_CONFIGURED' };
  try {
    await healthProbe.check();
    return { status: 'ok' };
  } catch {
    return { status: 'error', code: unavailableCode(dependency) };
  }
}

export async function checkApiReadiness(
  checks: ApiHealthChecks,
  now = new Date(),
): Promise<Readiness> {
  const [database, redis] = await Promise.all([
    probe('database', checks.database),
    probe('redis', checks.redis),
  ]);
  const dependencies = {
    database,
    redis,
    ai: checks.aiConfigured
      ? ({ status: 'ok' } satisfies HealthDependency)
      : ({ status: 'not_configured', code: 'AI_NOT_CONFIGURED' } satisfies HealthDependency),
  };
  const requiredHealthy = database.status === 'ok' && redis.status === 'ok';
  return readinessSchema.parse({
    status: requiredHealthy ? 'ok' : 'degraded',
    timestamp: now.toISOString(),
    dependencies,
  });
}
