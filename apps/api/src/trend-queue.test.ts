import { trendQueueName } from '@lettermate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { BullTrendQueue, createBullTrendQueue, manualTrendJobId } from './trend-queue.js';

describe('BullTrendQueue', () => {
  it('uses one deterministic active manual job per user with worker retry options', async () => {
    const queue = { add: vi.fn(), close: vi.fn() };
    const redis = { quit: vi.fn() };
    const trendQueue = new BullTrendQueue(queue as never, redis as never);

    await trendQueue.enqueue({ userId: 'user-a', trigger: 'manual' });
    await trendQueue.enqueue({ userId: 'user-a', trigger: 'manual' });

    expect(queue.add).toHaveBeenCalledTimes(2);
    for (const call of queue.add.mock.calls) {
      expect(call).toEqual([
        'manual-refresh',
        { userId: 'user-a', trigger: 'manual' },
        {
          jobId: manualTrendJobId('user-a'),
          attempts: 3,
          backoff: { type: 'custom' },
          removeOnComplete: true,
          removeOnFail: true,
        },
      ]);
    }
  });

  it('closes both owned resources', async () => {
    const queue = { add: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const redis = { quit: vi.fn().mockResolvedValue('OK') };
    const trendQueue = new BullTrendQueue(queue as never, redis as never);

    await trendQueue.close();

    expect(queue.close).toHaveBeenCalledOnce();
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  it('produces a BullMQ-safe deterministic id for arbitrary authenticated ids', () => {
    const first = manualTrendJobId('tenant:user/a');

    expect(first).toBe(manualTrendJobId('tenant:user/a'));
    expect(first).toMatch(/^manual-trend-[a-f0-9]{64}$/);
    expect(first).not.toContain(':');
  });

  it('constructs the BullMQ queue with the shared queue name', () => {
    expect(trendQueueName).toBe('trend-discovery');
    expect(createBullTrendQueue).toEqual(expect.any(Function));
  });
});
