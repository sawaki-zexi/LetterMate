import { describe, expect, it } from 'vitest';
import { checkApiReadiness } from './health.js';

describe('API readiness checks', () => {
  it('reports database, Redis and AI configuration separately', async () => {
    const readiness = await checkApiReadiness({
      database: { check: async () => {} },
      redis: { check: async () => { throw new Error('redis secret'); } },
      aiConfigured: false,
    }, new Date('2026-08-05T00:00:00.000Z'));

    expect(readiness).toEqual({
      status: 'degraded',
      timestamp: '2026-08-05T00:00:00.000Z',
      dependencies: {
        database: { status: 'ok' },
        redis: { status: 'error', code: 'REDIS_UNAVAILABLE' },
        ai: { status: 'not_configured', code: 'AI_NOT_CONFIGURED' },
      },
    });
    expect(JSON.stringify(readiness)).not.toContain('secret');
  });

  it('marks missing probes as not configured without exposing internals', async () => {
    await expect(checkApiReadiness({ aiConfigured: true })).resolves.toMatchObject({
      status: 'degraded',
      dependencies: {
        database: { status: 'not_configured' },
        redis: { status: 'not_configured' },
        ai: { status: 'ok' },
      },
    });
  });
});
