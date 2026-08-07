import { describe, expect, it } from 'vitest';
import {
  inspectWorkerConfiguration,
  RuntimeDependencyError,
  toSafeRuntimeFailure,
} from './runtime-health.js';

describe('worker runtime health', () => {
  it('distinguishes configured external dependencies', () => {
    expect(inspectWorkerConfiguration({
      DATABASE_URL: 'postgresql://localhost/db',
      REDIS_URL: 'redis://localhost',
      AI_API_KEY: undefined,
    })).toEqual({ database: 'configured', redis: 'configured', ai: 'not_configured' });
  });

  it('maps dependency failures to safe structured errors', () => {
    expect(toSafeRuntimeFailure(
      new RuntimeDependencyError('TOPIC_SCHEDULER_REDIS_UNAVAILABLE', 'redis', 'private'),
      'SCHEDULER_SCAN_FAILED',
      'database',
    )).toEqual({
      code: 'TOPIC_SCHEDULER_REDIS_UNAVAILABLE',
      dependency: 'redis',
      message: 'private',
    });

    expect(toSafeRuntimeFailure(new Error('redis://secret'), 'SCHEDULER_SCAN_FAILED', 'redis'))
      .toEqual({
        code: 'SCHEDULER_SCAN_FAILED',
        dependency: 'redis',
        message: 'Worker runtime dependency is temporarily unavailable',
      });
  });
});
