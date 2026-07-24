import { describe, expect, it, vi } from 'vitest';
import { BullTopicQueue } from './topic-queue.js';

describe('BullTopicQueue', () => {
  it('deduplicates only active jobs and permits later refreshes', async () => {
    const queue = { add: vi.fn(), close: vi.fn() };
    const redis = { quit: vi.fn() };
    const topicQueue = new BullTopicQueue(queue as never, redis as never);

    await topicQueue.enqueue({ topicId: 'topic-1', userId: 'user-a' });

    expect(queue.add).toHaveBeenCalledWith(
      'refresh',
      { topicId: 'topic-1', userId: 'user-a' },
      expect.objectContaining({
        jobId: 'topic-topic-1',
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });
});
