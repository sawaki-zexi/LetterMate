import { trendQueueName } from '@lettermate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { BullTrendQueue, createBullTrendQueue, manualTrendJobId } from './trend-queue.js';

describe('BullTrendQueue', () => {
  it('uses the durable run registration for collision-free retryable manual jobs', async () => {
    const queue = { add: vi.fn(), close: vi.fn() };
    const redis = { quit: vi.fn() };
    const trendQueue = new BullTrendQueue(queue as never, redis as never);

    await trendQueue.enqueue({ userId: 'user-a', trigger: 'manual', runId: 'run-1' });
    await trendQueue.enqueue({ userId: 'user-a', trigger: 'manual', runId: 'run-2' });

    expect(queue.add).toHaveBeenCalledTimes(2);
    for (const call of queue.add.mock.calls) {
      expect(call).toEqual([
        'manual-refresh',
        expect.objectContaining({ userId: 'user-a', trigger: 'manual' }),
        {
          jobId: expect.stringMatching(/^manual-trend-[a-f0-9]{64}$/),
          attempts: 3,
          backoff: { type: 'custom' },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 604_800, count: 1_000 },
        },
      ]);
    }
    expect(queue.add.mock.calls[0]![2].jobId).toBe(manualTrendJobId('run-1'));
    expect(queue.add.mock.calls[1]![2].jobId).toBe(manualTrendJobId('run-2'));
    expect(queue.add.mock.calls[0]![2].jobId).not.toBe(queue.add.mock.calls[1]![2].jobId);
  });

  it('closes both owned resources', async () => {
    const queue = { add: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const redis = { quit: vi.fn().mockResolvedValue('OK') };
    const trendQueue = new BullTrendQueue(queue as never, redis as never);

    await trendQueue.close();

    expect(queue.close).toHaveBeenCalledOnce();
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  it('probes Redis through the owned connection', async () => {
    const queue = { add: vi.fn(), close: vi.fn() };
    const redis = { quit: vi.fn(), ping: vi.fn().mockResolvedValue('PONG') };
    const trendQueue = new BullTrendQueue(queue as never, redis as never);

    await trendQueue.healthCheck();

    expect(redis.ping).toHaveBeenCalledOnce();
  });

  it('produces a BullMQ-safe deterministic id for arbitrary authenticated ids', () => {
    const first = manualTrendJobId('tenant:run/a');

    expect(first).toBe(manualTrendJobId('tenant:run/a'));
    expect(first).toMatch(/^manual-trend-[a-f0-9]{64}$/);
    expect(first).not.toContain(':');
  });

  it('constructs the BullMQ queue with the shared queue name', () => {
    expect(trendQueueName).toBe('trend-discovery');
    expect(createBullTrendQueue).toEqual(expect.any(Function));
  });
});
