import { parseConfig } from '@lettermate/config';
import { describe, expect, it, vi } from 'vitest';
import {
  configurationFailureReport,
  doctorLiveModeFromArgs,
  runOperationalDoctor,
} from './ops-doctor.js';

describe('operational doctor', () => {
  it('accepts npm-safe positional and direct live flags', () => {
    expect(doctorLiveModeFromArgs(['live'])).toBe(true);
    expect(doctorLiveModeFromArgs(['--live'])).toBe(true);
    expect(doctorLiveModeFromArgs([])).toBe(false);
  });

  it('reports capabilities without exposing configured secrets or URLs', async () => {
    const report = await runOperationalDoctor(parseConfig({
      AI_API_KEY: 'ai-secret-value',
      TWITTERAPI_IO_API_KEY: 'x-secret-value',
      DATABASE_URL: 'postgresql://user:database-secret@database.internal/app',
      REDIS_URL: 'redis://:redis-secret@redis.internal:6379',
    }), { now: () => new Date('2026-08-09T00:00:00.000Z') });
    const serialized = JSON.stringify(report);

    expect(report).toMatchObject({
      status: 'warning',
      timestamp: '2026-08-09T00:00:00.000Z',
      mode: 'configuration',
    });
    expect(report.sources).toContainEqual({ id: 'twitterapi-io', status: 'enabled' });
    expect(serialized).not.toContain('ai-secret-value');
    expect(serialized).not.toContain('x-secret-value');
    expect(serialized).not.toContain('database.internal');
    expect(serialized).not.toContain('redis.internal');
  });

  it('runs and closes live dependency probes', async () => {
    const databaseProbe = { check: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const redisProbe = { check: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const report = await runOperationalDoctor(parseConfig({
      ALLOW_DEV_IDENTITY: 'false',
      WEB_ORIGIN: 'https://discovery.example.com',
    }), { live: true, databaseProbe, redisProbe });

    expect(report.status).toBe('ok');
    expect(report.checks).toEqual(expect.arrayContaining([
      { id: 'database', status: 'ok' },
      { id: 'redis', status: 'ok' },
    ]));
    expect(databaseProbe.close).toHaveBeenCalledOnce();
    expect(redisProbe.close).toHaveBeenCalledOnce();
  });

  it('maps dependency and cleanup failures to safe error codes', async () => {
    const databaseProbe = {
      check: vi.fn(async () => { throw new Error('postgresql://secret'); }),
      close: vi.fn(async () => {}),
    };
    const redisProbe = {
      check: vi.fn(async () => {}),
      close: vi.fn(async () => { throw new Error('redis://secret'); }),
    };
    const report = await runOperationalDoctor(parseConfig({
      ALLOW_DEV_IDENTITY: 'false',
      WEB_ORIGIN: 'https://discovery.example.com',
    }), { live: true, databaseProbe, redisProbe });

    expect(report.status).toBe('error');
    expect(report.checks).toEqual(expect.arrayContaining([
      { id: 'database', status: 'error', code: 'DATABASE_UNAVAILABLE' },
      { id: 'redis', status: 'error', code: 'REDIS_UNAVAILABLE' },
    ]));
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('creates a stable redacted configuration failure', () => {
    expect(configurationFailureReport(new Date('2026-08-09T01:00:00.000Z'))).toEqual({
      status: 'error',
      timestamp: '2026-08-09T01:00:00.000Z',
      mode: 'configuration',
      checks: [{ id: 'configuration', status: 'error', code: 'CONFIGURATION_INVALID' }],
      sources: [],
    });
  });
});
