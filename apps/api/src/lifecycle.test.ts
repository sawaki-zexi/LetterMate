import { describe, expect, it, vi } from 'vitest';
import { createApiShutdown } from './lifecycle.js';

describe('API lifecycle shutdown', () => {
  it('closes the application once when signals race', async () => {
    const close = vi.fn(async () => {});
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const shutdown = createApiShutdown({ close }, logger);

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledTimes(2);
    expect(logger.log.mock.calls.map(([value]) => JSON.parse(value).event)).toEqual([
      'api.stopping',
      'api.stopped',
    ]);
  });

  it('logs a safe failure and rejects when close fails', async () => {
    const close = vi.fn(async () => { throw new Error('database password'); });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const shutdown = createApiShutdown({ close }, logger);

    await expect(shutdown('SIGTERM')).rejects.toThrow('API shutdown failed');

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).not.toContain('database password');
    expect(logger.error.mock.calls[0]?.[0]).toContain('API_SHUTDOWN_FAILED');
  });
});
