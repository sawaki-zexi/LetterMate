import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  PrismaTopicScheduleRepository,
  TopicScheduleService,
  calculateScheduleUpdate,
  scheduledJobId,
  startTopicScheduler,
} from './scheduler.js';

const finishedAt = new Date('2026-07-27T10:00:00.000Z');

describe('adaptive topic schedule', () => {
  it('shortens to six hours after two productive scheduled runs', () => {
    const result = calculateScheduleUpdate({
      topicId: 'topic-1',
      trigger: 'scheduled',
      newItemCount: 2,
      state: {
        scheduleIntervalHours: 12,
        productiveRunStreak: 1,
        emptyRunStreak: 0,
      },
      finishedAt,
    });

    expect(result).toMatchObject({
      scheduleIntervalHours: 6,
      productiveRunStreak: 2,
      emptyRunStreak: 0,
    });
  });

  it('extends to 24 hours after two empty scheduled runs', () => {
    const result = calculateScheduleUpdate({
      topicId: 'topic-1',
      trigger: 'scheduled',
      newItemCount: 0,
      state: {
        scheduleIntervalHours: 12,
        productiveRunStreak: 0,
        emptyRunStreak: 1,
      },
      finishedAt,
    });

    expect(result).toMatchObject({
      scheduleIntervalHours: 24,
      productiveRunStreak: 0,
      emptyRunStreak: 2,
    });
  });

  it('uses stable jitter within ten percent of the interval', () => {
    const input = {
      topicId: 'topic-stable',
      trigger: 'initial' as const,
      newItemCount: 0,
      state: {
        scheduleIntervalHours: 12 as const,
        productiveRunStreak: 0,
        emptyRunStreak: 0,
      },
      finishedAt,
    };

    const first = calculateScheduleUpdate(input);
    const second = calculateScheduleUpdate(input);
    const delay = first.nextRunAt.getTime() - finishedAt.getTime();

    expect(first.nextRunAt).toEqual(second.nextRunAt);
    expect(delay).toBeGreaterThanOrEqual(12 * 60 * 60 * 1_000 * 0.9);
    expect(delay).toBeLessThanOrEqual(12 * 60 * 60 * 1_000 * 1.1);
  });
});

describe('PrismaTopicScheduleRepository', () => {
  it('conditionally claims only topics that are still due', async () => {
    const dueAt = new Date('2026-07-27T09:50:00.000Z');
    const prisma = {
      topic: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'topic-1', userId: 'user-1', nextRunAt: dueAt },
          { id: 'topic-2', userId: 'user-2', nextRunAt: dueAt },
        ]),
        updateMany: vi.fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    } as unknown as PrismaClient;
    const claimUntil = new Date('2026-07-27T10:10:00.000Z');

    const claimed = await new PrismaTopicScheduleRepository(prisma).claimDueTopics(
      finishedAt,
      claimUntil,
      50,
    );

    expect(claimed).toEqual([
      { topicId: 'topic-1', userId: 'user-1', dueAt },
    ]);
    expect((prisma.topic.updateMany as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      where: {
        id: 'topic-1',
        nextRunAt: dueAt,
        OR: [
          { runStatus: { not: 'running' } },
          { runLeaseUntil: null },
          { runLeaseUntil: { lte: finishedAt } },
        ],
      },
      data: {
        nextRunAt: claimUntil,
        runStatus: 'queued',
        queuedTrigger: 'scheduled',
      },
    });
  });

  it('claims a stale initial run even when it has no next scheduled time', async () => {
    const leaseExpiredAt = new Date('2026-07-27T09:55:00.000Z');
    const prisma = {
      topic: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'topic-initial', userId: 'user-1', nextRunAt: null,
          runStatus: 'running', runLeaseUntil: leaseExpiredAt,
        }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const claimUntil = new Date('2026-07-27T10:10:00.000Z');

    const claimed = await new PrismaTopicScheduleRepository(prisma).claimDueTopics(
      finishedAt,
      claimUntil,
      50,
    );

    expect(claimed).toEqual([{
      topicId: 'topic-initial', userId: 'user-1', dueAt: leaseExpiredAt,
    }]);
    expect((prisma.topic.updateMany as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      where: {
        id: 'topic-initial',
        runStatus: 'running',
        runLeaseUntil: leaseExpiredAt,
      },
      data: { nextRunAt: claimUntil, runStatus: 'queued', queuedTrigger: 'scheduled' },
    });
  });
});

describe('TopicScheduleService', () => {
  it('enqueues claimed topics with deterministic scheduled job IDs', async () => {
    const dueAt = new Date('2026-07-27T09:50:00.000Z');
    const repository = {
      claimDueTopics: vi.fn().mockResolvedValue([
        { topicId: 'topic-1', userId: 'user-1', dueAt },
      ]),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const service = new TopicScheduleService(repository, queue, {
      claimLeaseMs: 10 * 60 * 1_000,
      limit: 50,
    });

    await service.scan(finishedAt);

    expect(repository.claimDueTopics).toHaveBeenCalledWith(
      finishedAt,
      new Date('2026-07-27T10:10:00.000Z'),
      50,
    );
    expect(queue.add).toHaveBeenCalledWith(
      'scheduled-refresh',
      { topicId: 'topic-1', userId: 'user-1', trigger: 'scheduled' },
      expect.objectContaining({
        jobId: scheduledJobId('topic-1', dueAt),
        attempts: 3,
        backoff: { type: 'custom' },
      }),
    );
  });

  it('does not enqueue the same due topic on an empty duplicate scan', async () => {
    const dueAt = new Date('2026-07-27T09:50:00.000Z');
    const repository = {
      claimDueTopics: vi.fn()
        .mockResolvedValueOnce([{ topicId: 'topic-1', userId: 'user-1', dueAt }])
        .mockResolvedValueOnce([]),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const service = new TopicScheduleService(repository, queue);

    await service.scan(finishedAt);
    await service.scan(finishedAt);

    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('startTopicScheduler', () => {
  it('contains a failed scan and runs the next scheduled scan', async () => {
    vi.useFakeTimers();
    const logger = { error: vi.fn() };
    const service = {
      scan: vi.fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValueOnce(0),
    };
    const scheduler = startTopicScheduler(service, { intervalMs: 1_000, logger });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(service.scan).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith('Topic scheduler scan failed');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(service.scan).toHaveBeenCalledTimes(2);
      await scheduler.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
