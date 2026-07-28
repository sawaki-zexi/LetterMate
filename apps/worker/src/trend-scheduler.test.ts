import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PrismaTrendScheduleRepository,
  TrendScheduleService,
  scheduledTrendJobId,
  startTrendScheduler,
} from './trend-scheduler.js';

const now = new Date('2026-07-28T12:00:00.000Z');

describe('PrismaTrendScheduleRepository', () => {
  it('conditionally claims due and stale monitors with a scheduler lease', async () => {
    const dueAt = new Date('2026-07-28T11:50:00.000Z');
    const staleAt = new Date('2026-07-28T11:55:00.000Z');
    const prisma = {
      trendMonitor: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'monitor-due', userId: 'user-1', nextRunAt: dueAt,
            runStatus: 'succeeded', activeRunId: null, runLeaseUntil: null,
          },
          {
            id: 'monitor-stale', userId: 'user-2', nextRunAt: new Date('2026-07-28T16:00:00.000Z'),
            runStatus: 'running', activeRunId: 'run-stale', runLeaseUntil: staleAt,
          },
        ]),
        updateMany: vi.fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const claimUntil = new Date('2026-07-28T12:10:00.000Z');

    const claimed = await new PrismaTrendScheduleRepository(prisma).claimDueMonitors(
      now,
      claimUntil,
      50,
    );

    expect(claimed).toEqual([
      { monitorId: 'monitor-due', userId: 'user-1', dueAt },
      { monitorId: 'monitor-stale', userId: 'user-2', dueAt: staleAt },
    ]);
    expect(prisma.trendMonitor.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'monitor-due', nextRunAt: dueAt, activeRunId: null,
        OR: [
          { runStatus: { not: { in: ['queued', 'running'] } } },
          { runLeaseUntil: null },
          { runLeaseUntil: { lte: now } },
        ],
      },
      data: { nextRunAt: claimUntil, runStatus: 'queued', runLeaseUntil: claimUntil },
    });
    expect(prisma.trendMonitor.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'monitor-stale', activeRunId: 'run-stale',
        runStatus: 'running', runLeaseUntil: staleAt,
      },
      data: { nextRunAt: claimUntil, runStatus: 'queued', runLeaseUntil: claimUntil },
    });
  });
});

describe('TrendScheduleService', () => {
  it('enqueues deterministic scheduled jobs for claimed monitors', async () => {
    const dueAt = new Date('2026-07-28T11:50:00.000Z');
    const repository = {
      claimDueMonitors: vi.fn().mockResolvedValue([
        { monitorId: 'monitor-1', userId: 'user-1', dueAt },
      ]),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const service = new TrendScheduleService(repository, queue, {
      claimLeaseMs: 10 * 60_000,
      limit: 50,
    });

    await expect(service.scan(now)).resolves.toBe(1);

    expect(repository.claimDueMonitors).toHaveBeenCalledWith(
      now,
      new Date('2026-07-28T12:10:00.000Z'),
      50,
    );
    expect(queue.add).toHaveBeenCalledWith(
      'scheduled-refresh',
      { userId: 'user-1', trigger: 'scheduled' },
      expect.objectContaining({
        jobId: scheduledTrendJobId('monitor-1', dueAt),
        attempts: 3,
        backoff: { type: 'custom' },
      }),
    );
  });
});

describe('startTrendScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('scans immediately and every ten minutes by default', async () => {
    vi.useFakeTimers();
    const service = { scan: vi.fn().mockResolvedValue(0) };

    const scheduler = startTrendScheduler(service);
    await vi.waitFor(() => expect(service.scan).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(service.scan).toHaveBeenCalledTimes(2);

    scheduler.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(service.scan).toHaveBeenCalledTimes(2);
  });

  it('does not scan when trend monitoring is disabled', async () => {
    vi.useFakeTimers();
    const service = { scan: vi.fn().mockResolvedValue(0) };

    const scheduler = startTrendScheduler(service, { enabled: false });
    await vi.advanceTimersByTimeAsync(20 * 60_000);

    expect(service.scan).not.toHaveBeenCalled();
    scheduler.close();
  });
});
