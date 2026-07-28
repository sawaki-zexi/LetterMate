import type { PrismaClient } from '@prisma/client';
import type { DiscoveryCandidate } from '@lettermate/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PrismaTrendScheduleRepository,
  TrendScheduleService,
  scheduledTrendJobId,
  startTrendScheduler,
} from './trend-scheduler.js';
import { PrismaTrendRepository, TrendOrchestrationError } from './trend-service.js';

const now = new Date('2026-07-28T12:00:00.000Z');

describe('PrismaTrendScheduleRepository', () => {
  it('provisions users missing a monitor with the configured default interval', async () => {
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'user-new' }]) },
      trendMonitor: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;

    await expect(new PrismaTrendScheduleRepository(prisma, 8).claimDueMonitors(
      now,
      new Date('2026-07-28T12:10:00.000Z'),
      50,
    )).resolves.toEqual([]);

    expect(prisma.trendMonitor.createMany).toHaveBeenCalledWith({
      data: [{
        userId: 'user-new', intervalHours: 8, nextRunAt: now, runStatus: 'queued',
      }],
      skipDuplicates: true,
    });
  });

  it('conditionally claims due and stale monitors with a scheduler lease', async () => {
    const dueAt = new Date('2026-07-28T11:50:00.000Z');
    const staleAt = new Date('2026-07-28T11:55:00.000Z');
    const staleTransaction = {
      trendMonitor: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      trendRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
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
          .mockResolvedValueOnce({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn(async (callback) => callback(staleTransaction)),
    } as unknown as PrismaClient;
    const claimUntil = new Date('2026-07-28T12:10:00.000Z');

    const claimed = await new PrismaTrendScheduleRepository(prisma).claimDueMonitors(
      now,
      claimUntil,
      50,
    );

    expect(claimed).toEqual([
      { monitorId: 'monitor-due', userId: 'user-1', dueAt, claimUntil },
      { monitorId: 'monitor-stale', userId: 'user-2', dueAt: staleAt, claimUntil },
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
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(staleTransaction.trendRun.updateMany).toHaveBeenCalledOnce();
  });

  it('atomically fails an expired manual run and releases it for scheduled recovery', async () => {
    const staleAt = new Date('2026-07-28T11:55:00.000Z');
    const claimUntil = new Date('2026-07-28T12:10:00.000Z');
    const transaction = {
      trendMonitor: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      trendRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      trendMonitor: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'monitor-1', userId: 'user-1', nextRunAt: new Date('2026-07-28T16:00:00.000Z'),
          runStatus: 'running', activeRunId: 'manual-run', runLeaseUntil: staleAt,
        }]),
        updateMany: vi.fn(),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn(async (callback) => callback(transaction)),
    } as unknown as PrismaClient;

    await expect(new PrismaTrendScheduleRepository(prisma).claimDueMonitors(
      now,
      claimUntil,
      50,
    )).resolves.toEqual([{
      monitorId: 'monitor-1', userId: 'user-1', dueAt: staleAt, claimUntil,
    }]);

    expect(transaction.trendMonitor.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'monitor-1', userId: 'user-1', activeRunId: 'manual-run',
        runStatus: 'running', runLeaseUntil: staleAt,
      },
      data: {
        nextRunAt: claimUntil, runStatus: 'queued', activeRunId: null,
        runLeaseUntil: claimUntil,
      },
    });
    expect(transaction.trendRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'manual-run', userId: 'user-1', status: { in: ['queued', 'running'] },
      },
      data: {
        status: 'failed', finishedAt: now,
        error: {
          code: 'TREND_RUN_LEASE_EXPIRED',
          message: 'Trend run lease expired',
        },
      },
    });
  });

  it('conditionally releases the exact scheduler reservation after enqueue failure', async () => {
    const dueAt = new Date('2026-07-28T11:50:00.000Z');
    const claimUntil = new Date('2026-07-28T12:10:00.000Z');
    const prisma = {
      trendMonitor: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as PrismaClient;
    const repository = new PrismaTrendScheduleRepository(prisma);

    await expect(repository.releaseClaim({
      monitorId: 'monitor-1', userId: 'user-1', dueAt, claimUntil,
    })).resolves.toBe(true);

    expect(prisma.trendMonitor.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'monitor-1', userId: 'user-1', runStatus: 'queued', activeRunId: null,
        nextRunAt: claimUntil, runLeaseUntil: claimUntil,
      },
      data: {
        nextRunAt: dueAt, runStatus: 'failed', runLeaseUntil: null,
        lastError: {
          code: 'TREND_QUEUE_UNAVAILABLE',
          message: 'Trend discovery could not be queued',
        },
      },
    });
  });

  it('recovers an expired manual run into a claimable scheduled run and fences the stale worker', async () => {
    const staleAt = new Date('2026-07-28T11:55:00.000Z');
    const claimUntil = new Date('2026-07-28T12:10:00.000Z');
    const monitor = {
      id: 'monitor-1', userId: 'user-1', nextRunAt: new Date('2026-07-28T16:00:00.000Z'),
      intervalHours: 4, runStatus: 'running', activeRunId: 'manual-run',
      runLeaseUntil: staleAt, manualRefreshPending: false, lastError: null,
    };
    const runs = new Map([['manual-run', {
      id: 'manual-run', userId: 'user-1', trigger: 'manual', status: 'running',
    }]]);
    const monitorMatches = (where: Record<string, unknown>) => {
      if (typeof where.activeRunId === 'string' && where.activeRunId !== monitor.activeRunId) return false;
      if (where.activeRunId === null && monitor.activeRunId !== null) return false;
      if (typeof where.runStatus === 'string' && where.runStatus !== monitor.runStatus) return false;
      if (where.runLeaseUntil instanceof Date && where.runLeaseUntil.getTime() !== monitor.runLeaseUntil?.getTime()) return false;
      if (where.runLeaseUntil && !(where.runLeaseUntil instanceof Date) &&
        'gt' in (where.runLeaseUntil as object) &&
        !(monitor.runLeaseUntil && monitor.runLeaseUntil > (where.runLeaseUntil as { gt: Date }).gt)) return false;
      return true;
    };
    const transaction = {
      trendMonitor: {
        findUnique: vi.fn(async () => ({ ...monitor })),
        updateMany: vi.fn(async ({ where, data }) => {
          if (!monitorMatches(where)) return { count: 0 };
          Object.assign(monitor, data);
          return { count: 1 };
        }),
        update: vi.fn(),
      },
      trendRun: {
        updateMany: vi.fn(async ({ where, data }) => {
          const run = runs.get(where.id);
          if (!run) return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        }),
        create: vi.fn(async ({ data }) => {
          runs.set(data.id, { ...data });
          return data;
        }),
      },
    };
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      trendMonitor: {
        findMany: vi.fn().mockResolvedValue([{ ...monitor }]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback) => callback(transaction)),
    };

    await expect(new PrismaTrendScheduleRepository(prisma as never).claimDueMonitors(
      now, claimUntil, 50,
    )).resolves.toHaveLength(1);
    expect(runs.get('manual-run')).toMatchObject({ status: 'failed' });
    expect(monitor).toMatchObject({ activeRunId: null, runStatus: 'queued' });

    const repository = new PrismaTrendRepository(prisma as never, 10 * 60_000);
    const recovered = await repository.claimRun('user-1', 'scheduled', now);
    expect(recovered).toMatchObject({ state: 'claimed', monitorId: 'monitor-1' });
    if (recovered.state !== 'claimed') throw new Error('Expected a recovered scheduled run');
    expect(recovered.runId).not.toBe('manual-run');

    const staleItem: DiscoveryCandidate = {
      kind: 'hot', title: 'Stale item', summary: 'Summary', reason: 'Reason',
      sourceUrls: ['https://example.com/stale'], publishedAt: null, sourceType: 'web',
      platform: 'Web', authorName: null, authorHandle: null, externalId: null,
      provenanceKind: 'fetched_page',
    };
    await expect(repository.completeSuccess({
      runId: 'manual-run', monitorId: 'monitor-1', userId: 'user-1', trigger: 'manual',
      candidateCount: 1, acceptedCount: 1, items: [staleItem], finishedAt: now,
    })).rejects.toBeInstanceOf(TrendOrchestrationError);
  });
});

describe('TrendScheduleService', () => {
  it('enqueues deterministic scheduled jobs for claimed monitors', async () => {
    const dueAt = new Date('2026-07-28T11:50:00.000Z');
    const repository = {
      claimDueMonitors: vi.fn().mockResolvedValue([
        {
          monitorId: 'monitor-1', userId: 'user-1', dueAt,
          claimUntil: new Date('2026-07-28T12:10:00.000Z'),
        },
      ]),
      releaseClaim: vi.fn(),
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

  it('releases only the failed enqueue claim, logs safely, and counts successful jobs', async () => {
    const claimUntil = new Date('2026-07-28T12:10:00.000Z');
    const claims = [{
      monitorId: 'monitor-1', userId: 'user-1',
      dueAt: new Date('2026-07-28T11:50:00.000Z'), claimUntil,
    }, {
      monitorId: 'monitor-2', userId: 'user-2',
      dueAt: new Date('2026-07-28T11:55:00.000Z'), claimUntil,
    }];
    const repository = {
      claimDueMonitors: vi.fn().mockResolvedValue(claims),
      releaseClaim: vi.fn().mockResolvedValue(true),
    };
    const queue = {
      add: vi.fn()
        .mockRejectedValueOnce(new Error('redis://user:secret@example'))
        .mockResolvedValueOnce(undefined),
    };
    const logger = { error: vi.fn() };
    const service = new TrendScheduleService(repository, queue, { logger });

    await expect(service.scan(now)).resolves.toBe(1);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(repository.releaseClaim).toHaveBeenCalledOnce();
    expect(repository.releaseClaim).toHaveBeenCalledWith(claims[0]);
    expect(logger.error).toHaveBeenCalledWith('Trend scheduler enqueue failed; claim released');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
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

  it('logs a safe error when a scan fails', async () => {
    vi.useFakeTimers();
    const service = { scan: vi.fn().mockRejectedValue(new Error('secret redis endpoint')) };
    const logger = { error: vi.fn() };

    const scheduler = startTrendScheduler(service, { logger });
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.error).toHaveBeenCalledWith('Trend scheduler scan failed');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    scheduler.close();
  });

  it('prevents overlapping scans and waits for the active scan during close', async () => {
    vi.useFakeTimers();
    let finishScan!: () => void;
    const activeScan = new Promise<void>((resolve) => { finishScan = resolve; });
    const service = { scan: vi.fn().mockReturnValue(activeScan) };
    const scheduler = startTrendScheduler(service, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(3000);
    expect(service.scan).toHaveBeenCalledOnce();

    let closed = false;
    const closing = scheduler.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishScan();
    await closing;
    expect(closed).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.scan).toHaveBeenCalledOnce();
  });
});
