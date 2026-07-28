import { describe, expect, it, vi } from 'vitest';
import { createWorkerShutdown } from './lifecycle.js';

describe('worker lifecycle shutdown', () => {
  it('is idempotent and closes every phase even when an earlier close rejects', async () => {
    const schedulerClose = vi.fn().mockRejectedValue(new Error('scheduler secret'));
    const workerClose = vi.fn().mockRejectedValue(new Error('worker secret'));
    const queueClose = vi.fn().mockResolvedValue(undefined);
    const redisQuit = vi.fn().mockResolvedValue('OK');
    const prismaDisconnect = vi.fn().mockResolvedValue(undefined);
    const logger = { error: vi.fn() };
    const shutdown = createWorkerShutdown({
      schedulers: [{ close: schedulerClose }],
      workers: [{ close: workerClose }],
      queues: [{ close: queueClose }],
      redis: { quit: redisQuit },
      prisma: { $disconnect: prismaDisconnect },
      logger,
    });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await first;

    expect(schedulerClose).toHaveBeenCalledOnce();
    expect(workerClose).toHaveBeenCalledOnce();
    expect(queueClose).toHaveBeenCalledOnce();
    expect(redisQuit).toHaveBeenCalledOnce();
    expect(prismaDisconnect).toHaveBeenCalledOnce();
    expect(schedulerClose.mock.invocationCallOrder[0])
      .toBeLessThan(workerClose.mock.invocationCallOrder[0]!);
    expect(workerClose.mock.invocationCallOrder[0])
      .toBeLessThan(redisQuit.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });
});
