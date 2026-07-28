import { type TrendJobData } from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';

export interface ClaimedTrendMonitor {
  monitorId: string;
  userId: string;
  dueAt: Date;
}

export interface TrendScheduleRepository {
  claimDueMonitors(now: Date, claimUntil: Date, limit: number): Promise<ClaimedTrendMonitor[]>;
}

export class PrismaTrendScheduleRepository implements TrendScheduleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claimDueMonitors(
    now: Date,
    claimUntil: Date,
    limit: number,
  ): Promise<ClaimedTrendMonitor[]> {
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
      const result = await this.prisma.trendMonitor.updateMany({
        where: stale
          ? {
              id: monitor.id,
              activeRunId: monitor.activeRunId,
              runStatus: monitor.runStatus,
              runLeaseUntil: monitor.runLeaseUntil,
            }
          : {
              id: monitor.id,
              nextRunAt: monitor.nextRunAt,
              activeRunId: null,
              OR: [
                { runStatus: { not: { in: ['queued', 'running'] } } },
                { runLeaseUntil: null },
                { runLeaseUntil: { lte: now } },
              ],
            },
        data: { nextRunAt: claimUntil, runStatus: 'queued', runLeaseUntil: claimUntil },
      });
      if (result.count === 1) {
        claimed.push({ monitorId: monitor.id, userId: monitor.userId, dueAt });
      }
    }
    return claimed;
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
      removeOnComplete: boolean;
      removeOnFail: boolean;
    },
  ): Promise<unknown>;
}

export interface TrendScheduleServiceOptions {
  claimLeaseMs: number;
  limit: number;
}

const defaultOptions: TrendScheduleServiceOptions = {
  claimLeaseMs: 10 * 60_000,
  limit: 50,
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
    const monitors = await this.repository.claimDueMonitors(now, claimUntil, this.options.limit);
    await Promise.all(monitors.map((monitor) => this.queue.add(
      'scheduled-refresh',
      { userId: monitor.userId, trigger: 'scheduled' },
      {
        jobId: scheduledTrendJobId(monitor.monitorId, monitor.dueAt),
        attempts: 3,
        backoff: { type: 'custom' },
        removeOnComplete: true,
        removeOnFail: true,
      },
    )));
    return monitors.length;
  }
}

export function startTrendScheduler(
  service: Pick<TrendScheduleService, 'scan'>,
  options: { enabled?: boolean; intervalMs?: number } = {},
): { close(): void } {
  if (options.enabled === false) return { close: () => undefined };
  const scan = () => void service.scan().catch(() => undefined);
  scan();
  const timer = setInterval(scan, options.intervalMs ?? 10 * 60_000);
  timer.unref();
  return { close: () => clearInterval(timer) };
}
