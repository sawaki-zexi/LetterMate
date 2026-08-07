export type RuntimeDependency = 'database' | 'redis' | 'external';

export class RuntimeDependencyError extends Error {
  constructor(
    public readonly code: string,
    public readonly dependency: RuntimeDependency,
    message = 'Worker dependency is unavailable',
  ) {
    super(message);
    this.name = 'RuntimeDependencyError';
  }
}

export function toSafeRuntimeFailure(
  error: unknown,
  fallbackCode: string,
  fallbackDependency: RuntimeDependency,
): { code: string; dependency: RuntimeDependency; message: string } {
  if (error instanceof RuntimeDependencyError) {
    return { code: error.code, dependency: error.dependency, message: error.message };
  }
  return {
    code: fallbackCode,
    dependency: fallbackDependency,
    message: 'Worker runtime dependency is temporarily unavailable',
  };
}

export interface WorkerConfigurationStatus {
  database: 'configured' | 'not_configured';
  redis: 'configured' | 'not_configured';
  ai: 'configured' | 'not_configured';
}

export function inspectWorkerConfiguration(config: {
  DATABASE_URL: string;
  REDIS_URL: string;
  AI_API_KEY: string | undefined;
}): WorkerConfigurationStatus {
  return {
    database: config.DATABASE_URL ? 'configured' : 'not_configured',
    redis: config.REDIS_URL ? 'configured' : 'not_configured',
    ai: config.AI_API_KEY ? 'configured' : 'not_configured',
  };
}
