import { describe, expect, it, vi } from 'vitest';
import { BullTopicQueue } from './topic-queue.js';

describe('BullTopicQueue', () => {
  it('deduplicates only active jobs and permits later refreshes', async () => {
    const queue = { add: vi.fn(), close: vi.fn() };
    const redis = { quit: vi.fn() };
    const topicQueue = new BullTopicQueue(queue as never, redis as never);

    await topicQueue.enqueue({ topicId: 'topic-1', userId: 'user-a', trigger: 'manual' });
    await topicQueue.enqueue({ topicId: 'topic-1', userId: 'user-a', trigger: 'manual' });

    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'refresh',
      { topicId: 'topic-1', userId: 'user-a', trigger: 'manual' },
      expect.objectContaining({
        jobId: expect.stringMatching(/^manual-topic-1-/),
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    const firstId = queue.add.mock.calls[0]![2].jobId;
    const secondId = queue.add.mock.calls[1]![2].jobId;
    expect(firstId).not.toBe(secondId);
  });

  it('probes Redis without exposing connection details', async () => {
    const queue = { add: vi.fn(), close: vi.fn() };
    const redis = { quit: vi.fn(), ping: vi.fn().mockResolvedValue('PONG') };
    const topicQueue = new BullTopicQueue(queue as never, redis as never);

    await topicQueue.healthCheck();

    expect(redis.ping).toHaveBeenCalledOnce();
  });
});
