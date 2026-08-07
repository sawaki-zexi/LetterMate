import { type TrendJobData } from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';
import { RuntimeDependencyError, toSafeRuntimeFailure } from './runtime-health.js';

export interface ClaimedTrendMonitor {
  monitorId: string;
  userId: string;
  dueAt: Date;
  claimUntil: Date;
}

export interface TrendScheduleRepository {
  claimDueMonitors(now: Date, claimUntil: Date, limit: number): Promise<ClaimedTrendMonitor[]>;
  releaseClaim(claim: ClaimedTrendMonitor): Promise<boolean>;
}

export class PrismaTrendScheduleRepository implements TrendScheduleRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly defaultIntervalHours = 4,
  ) {}

  async claimDueMonitors(
    now: Date,
    claimUntil: Date,
    limit: number,
  ): Promise<ClaimedTrendMonitor[]> {
    const missing = await this.prisma.user.findMany({
      where: { trendMonitor: { is: null } },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (missing.length > 0) {
      await this.prisma.trendMonitor.createMany({
        data: missing.map(({ id: userId }) => ({
          userId,
          intervalHours: this.defaultIntervalHours,
          nextRunAt: now,
          runStatus: 'queued' as const,
        })),
        skipDuplicates: true,
      });
    }
    const monitors = await this.prisma.trendMonitor.findMany({
      where: {
        OR: [
          {
            nextRunAt: { lte: now },
            OR: [
              { activeRunId: null },
              { runLeaseUntil: null },
              { runLeaseUntil: { lte: now } },
            ],
          },
          {
            activeRunId: { not: null },
            runStatus: { in: ['queued', 'running'] },
            OR: [{ runLeaseUntil: null }, { runLeaseUntil: { lte: now } }],
          },
        ],
      },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        userId: true,
        nextRunAt: true,
        runStatus: true,
        activeRunId: true,
        runLeaseUntil: true,
      },
    });
    const claimed: ClaimedTrendMonitor[] = [];
    for (const monitor of monitors) {
      const stale = monitor.activeRunId !== null &&
        (monitor.runLeaseUntil === null || monitor.runLeaseUntil <= now);
      const dueAt = stale ? (monitor.runLeaseUntil ?? monitor.nextRunAt) : monitor.nextRunAt;
      const acquired = stale
        ? await this.prisma.$transaction(async (transaction) => {
            const oldRunId = monitor.activeRunId!;
            const result = await transaction.trendMonitor.updateMany({
              where: {
                id: monitor.id,
                userId: monitor.userId,
                activeRunId: oldRunId,
                runStatus: monitor.runStatus,
                runLeaseUntil: monitor.runLeaseUntil,
              },
              data: {
                nextRunAt: dueAt,
                runStatus: 'queued',
                activeRunId: null,
                runLeaseUntil: claimUntil,
              },
            });
            if (result.count !== 1) return false;
            await transaction.trendRun.updateMany({
              where: {
                id: oldRunId,
                userId: monitor.userId,
                status: { in: ['queued', 'running'] },
              },
              data: {
                status: 'failed',
                finishedAt: now,
                error: {
                  code: 'TREND_RUN_LEASE_EXPIRED',
                  message: 'Trend run lease expired',
                },
              },
            });
            return true;
          })
        : (await this.prisma.trendMonitor.updateMany({
            where: {
              id: monitor.id,
              nextRunAt: monitor.nextRunAt,
              activeRunId: null,
              OR: [
                { runStatus: { not: { in: ['queued', 'running'] } } },
                { runLeaseUntil: null },
                { runLeaseUntil: { lte: now } },
              ],
            },
            data: { runStatus: 'queued', runLeaseUntil: claimUntil },
          })).count === 1;
      if (acquired) {
        claimed.push({
          monitorId: monitor.id,
          userId: monitor.userId,
          dueAt,
          claimUntil,
        });
      }
    }
    return claimed;
  }

  async releaseClaim(claim: ClaimedTrendMonitor): Promise<boolean> {
    const released = await this.prisma.trendMonitor.updateMany({
      where: {
        id: claim.monitorId,
        userId: claim.userId,
        runStatus: 'queued',
        activeRunId: null,
        nextRunAt: claim.dueAt,
        runLeaseUntil: claim.claimUntil,
      },
      data: {
        runStatus: 'failed',
        runLeaseUntil: null,
        lastError: {
          code: 'TREND_QUEUE_UNAVAILABLE',
          message: 'Trend discovery could not be queued',
        },
      },
    });
    return released.count === 1;
  }
}

interface TrendScheduleQueue {
  add(
    name: string,
    data: TrendJobData,
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: string };
      removeOnComplete: { age: number; count: number };
      removeOnFail: { age: number; count: number };
    },
  ): Promise<unknown>;
}

export interface TrendScheduleServiceOptions {
  claimLeaseMs: number;
  limit: number;
  logger: { error(message: string): void };
}

const defaultOptions: TrendScheduleServiceOptions = {
  claimLeaseMs: 10 * 60_000,
  limit: 50,
  logger: console,
};

export const scheduledTrendJobId = (monitorId: string, dueAt: Date): string =>
  `scheduled-trend-${monitorId}-${dueAt.getTime()}`;

export class TrendScheduleService {
  private readonly options: TrendScheduleServiceOptions;

  constructor(
    private readonly repository: TrendScheduleRepository,
    private readonly queue: TrendScheduleQueue,
    options: Partial<TrendScheduleServiceOptions> = {},
  ) {
    this.options = { ...defaultOptions, ...options };
  }

  async scan(now = new Date()): Promise<number> {
    const claimUntil = new Date(now.getTime() + this.options.claimLeaseMs);
    let monitors: ClaimedTrendMonitor[];
    try {
      monitors = await this.repository.claimDueMonitors(now, claimUntil, this.options.limit);
    } catch (error) {
      throw new RuntimeDependencyError(
        'TREND_SCHEDULER_DATABASE_UNAVAILABLE',
        'database',
        error instanceof Error ? 'Trend scheduler could not claim due monitors' : undefined,
      );
    }
    const results = await Promise.all(monitors.map(async (monitor) => {
      try {
        await this.queue.add(
          'scheduled-refresh',
          {
            userId: monitor.userId,
            trigger: 'scheduled',
            dueAt: monitor.dueAt.toISOString(),
          },
          {
            jobId: scheduledTrendJobId(monitor.monitorId, monitor.dueAt),
            attempts: 3,
            backoff: { type: 'custom' },
            removeOnComplete: { age: 3_600, count: 1_000 },
            removeOnFail: { age: 7 * 24 * 3_600, count: 1_000 },
          },
        );
        return true;
      } catch {
        let released = false;
        try {
          released = await this.repository.releaseClaim(monitor);
        } catch {
          // The conditional reservation remains recoverable after its lease expires.
        }
        this.options.logger.error(JSON.stringify({
          code: 'TREND_SCHEDULER_REDIS_UNAVAILABLE',
          dependency: 'redis',
          message: released
            ? 'Trend scheduler enqueue failed; claim released'
            : 'Trend scheduler enqueue failed; claim release was not applied',
        }));
        return false;
      }
    }));
    return results.filter(Boolean).length;
  }
}

export function startTrendScheduler(
  service: Pick<TrendScheduleService, 'scan'>,
  options: {
    enabled?: boolean;
    intervalMs?: number;
    logger?: { error(message: string): void };
  } = {},
): { close(): Promise<void> } {
  if (options.enabled === false) return { close: () => Promise.resolve() };
  const logger = options.logger ?? console;
  let closing = false;
  let inFlight: Promise<void> | null = null;
  const scan = () => {
    if (closing || inFlight !== null) return;
    const run = Promise.resolve()
      .then(() => service.scan())
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error(JSON.stringify(toSafeRuntimeFailure(
          error,
          'TREND_SCHEDULER_SCAN_FAILED',
          'database',
        )));
      });
    const tracked = run.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
  };
  scan();
  const timer = setInterval(scan, options.intervalMs ?? 10 * 60_000);
  timer.unref();
  return {
    close: () => {
      closing = true;
      clearInterval(timer);
      return inFlight ?? Promise.resolve();
    },
  };
}
