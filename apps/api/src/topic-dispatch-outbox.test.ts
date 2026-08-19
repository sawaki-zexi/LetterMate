import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryJobData } from '@lettermate/contracts';
import { MemoryTopicDispatchOutbox, TopicDispatchRelay } from './topic-dispatch-outbox.js';
import type { TopicQueue } from './topic-queue.js';

const job: DiscoveryJobData = { topicId: 'topic-1', userId: 'user-1', trigger: 'manual' };

class RecordingQueue implements TopicQueue {
  readonly jobs: Array<{ data: DiscoveryJobData; deliveryId?: string }> = [];
  async enqueue(data: DiscoveryJobData, deliveryId?: string) {
    this.jobs.push({ data: structuredClone(data), ...(deliveryId ? { deliveryId } : {}) });
  }
  async close() {}
}

describe('Topic dispatch outbox', () => {
  it('claims in creation order and acknowledges with a stable delivery id', async () => {
    const now = new Date('2026-08-19T10:00:00.000Z');
    const outbox = new MemoryTopicDispatchOutbox(() => now);
    const queue = new RecordingQueue();
    const relay = new TopicDispatchRelay(outbox, queue, { now: () => now });
    const first = await outbox.register(job);
    await outbox.register({ ...job, topicId: 'topic-2' });

    await Promise.all([relay.kick(), relay.kick()]);

    expect(queue.jobs).toEqual([
      { data: job, deliveryId: first },
      { data: { ...job, topicId: 'topic-2' }, deliveryId: 'dispatch-2' },
    ]);
    expect(outbox.snapshot().every((row) => row.dispatchedAt !== null)).toBe(true);
  });

  it('releases a failed claim and retries after the backoff window', async () => {
    let now = new Date('2026-08-19T10:00:00.000Z');
    const outbox = new MemoryTopicDispatchOutbox(() => now);
    const queue: TopicQueue = {
      enqueue: vi.fn()
        .mockRejectedValueOnce(new Error('redis unavailable'))
        .mockResolvedValueOnce(undefined),
      close: vi.fn(async () => {}),
    };
    const relay = new TopicDispatchRelay(outbox, queue, { now: () => now });
    await outbox.register(job);

    await relay.kick();
    expect(outbox.snapshot()[0]).toMatchObject({ attemptCount: 1, dispatchedAt: null });
    now = new Date(now.getTime() + 1_000);
    await relay.kick();
    expect(outbox.snapshot()[0]).toMatchObject({ attemptCount: 2, dispatchedAt: expect.any(Date) });
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });

  it('cancels pending deliveries and skips paused topics', async () => {
    const now = new Date('2026-08-19T10:00:00.000Z');
    const active = new Set(['topic-1']);
    const outbox = new MemoryTopicDispatchOutbox(() => now, (topicId) => active.has(topicId));
    await outbox.register(job);
    await outbox.register({ ...job, topicId: 'topic-2' });

    active.delete('topic-1');
    expect(await outbox.claim(10, now, 30_000)).toEqual([]);

    await outbox.cancelTopic('topic-2');
    expect(outbox.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: job, dispatchedAt: null }),
      expect.objectContaining({ data: { ...job, topicId: 'topic-2' }, lastErrorCode: 'TOPIC_CANCELLED' }),
    ]));
  });
});
