import { type CreatorJobData } from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';
import { RuntimeDependencyError, toSafeRuntimeFailure } from './runtime-health.js';

export interface ClaimedCreator {
  creatorId: string;
  userId: string;
  dueAt: Date;
  claimUntil: Date;
}

export interface CreatorScheduleRepository {
  claimDueCreators(now: Date, claimUntil: Date, limit: number): Promise<ClaimedCreator[]>;
  releaseClaim(creator: ClaimedCreator): Promise<boolean>;
}

export class PrismaCreatorScheduleRepository implements CreatorScheduleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claimDueCreators(now: Date, claimUntil: Date, limit: number): Promise<ClaimedCreator[]> {
    const due = await this.prisma.creatorSubscription.findMany({
      where: {
        cancelledAt: null,
        pausedAt: null,
        OR: [
          {
            nextRunAt: { lte: now },
            activeRunId: null,
            OR: [{ runStatus: { not: 'running' } }, { runLeaseUntil: null }, { runLeaseUntil: { lte: now } }],
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
      select: { id: true, userId: true, nextRunAt: true, runStatus: true, activeRunId: true, runLeaseUntil: true },
    });
    const claimed: ClaimedCreator[] = [];
    for (const creator of due) {
      if (!creator.nextRunAt) continue;
      const stale = creator.activeRunId !== null &&
        (creator.runLeaseUntil === null || creator.runLeaseUntil <= now);
      const acquired = await this.prisma.$transaction(async (transaction) => {
        if (stale && creator.activeRunId) {
          const result = await transaction.creatorSubscription.updateMany({
            where: {
              id: creator.id,
              userId: creator.userId,
              cancelledAt: null,
              activeRunId: creator.activeRunId,
              runLeaseUntil: creator.runLeaseUntil,
            },
            data: { runStatus: 'queued', activeRunId: null, runLeaseUntil: claimUntil },
          });
          if (result.count !== 1) return false;
          await transaction.creatorRun.updateMany({
            where: { id: creator.activeRunId, status: { in: ['queued', 'running'] } },
            data: { status: 'failed', finishedAt: now, error: { code: 'CREATOR_RUN_LEASE_EXPIRED' } },
          });
          return true;
        }
        return (await transaction.creatorSubscription.updateMany({
          where: {
            id: creator.id,
            userId: creator.userId,
            cancelledAt: null,
            pausedAt: null,
            nextRunAt: creator.nextRunAt,
            activeRunId: null,
            OR: [{ runStatus: { not: 'running' } }, { runLeaseUntil: null }, { runLeaseUntil: { lte: now } }],
          },
          data: { runStatus: 'queued', runLeaseUntil: claimUntil },
        })).count === 1;
      });
      if (acquired) claimed.push({ creatorId: creator.id, userId: creator.userId, dueAt: creator.nextRunAt, claimUntil });
    }
    return claimed;
  }

  async releaseClaim(claim: ClaimedCreator): Promise<boolean> {
    const result = await this.prisma.creatorSubscription.updateMany({
      where: {
        id: claim.creatorId,
        userId: claim.userId,
        cancelledAt: null,
        runStatus: 'queued',
        activeRunId: null,
        runLeaseUntil: claim.claimUntil,
      },
      data: { runStatus: 'failed', runLeaseUntil: null, lastError: { code: 'CREATOR_QUEUE_UNAVAILABLE', message: '博主任务暂时无法入队，请稍后重试' } },
    });
    return result.count === 1;
  }
}

interface CreatorScheduleQueue {
  add(name: string, data: CreatorJobData, options: {
    jobId: string;
    attempts: number;
    backoff: { type: string };
    removeOnComplete: { age: number; count: number };
    removeOnFail: { age: number; count: number };
  }): Promise<unknown>;
}

export const scheduledCreatorJobId = (creatorId: string, dueAt: Date): string => (
  `scheduled-creator-${creatorId}-${dueAt.getTime()}`
);

export class CreatorScheduleService {
  constructor(
    private readonly repository: CreatorScheduleRepository,
    private readonly queue: CreatorScheduleQueue,
    private readonly options: { claimLeaseMs: number; limit: number; logger: { error(message: string): void } } = {
      claimLeaseMs: 10 * 60_000,
      limit: 50,
      logger: console,
    },
  ) {}

  async scan(now = new Date()): Promise<number> {
    const claimUntil = new Date(now.getTime() + this.options.claimLeaseMs);
    let creators: ClaimedCreator[];
    try {
      creators = await this.repository.claimDueCreators(now, claimUntil, this.options.limit);
    } catch (error) {
      throw new RuntimeDependencyError('CREATOR_SCHEDULER_DATABASE_UNAVAILABLE', 'database', error instanceof Error ? error.message : undefined);
    }
    const results = await Promise.all(creators.map(async (creator) => {
      try {
        await this.queue.add('scheduled-refresh', {
          creatorId: creator.creatorId,
          userId: creator.userId,
          trigger: 'scheduled',
        }, {
          jobId: scheduledCreatorJobId(creator.creatorId, creator.dueAt),
          attempts: 3,
          backoff: { type: 'custom' },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 7 * 24 * 3_600, count: 1_000 },
        });
        return true;
      } catch {
        const released = await this.repository.releaseClaim(creator).catch(() => false);
        this.options.logger.error(JSON.stringify({
          code: 'CREATOR_SCHEDULER_REDIS_UNAVAILABLE',
          dependency: 'redis',
          released,
        }));
        return false;
      }
    }));
    return results.filter(Boolean).length;
  }
}

export function startCreatorScheduler(
  service: Pick<CreatorScheduleService, 'scan'>,
  options: { enabled?: boolean; intervalMs?: number; logger?: { error(message: string): void } } = {},
): { close(): Promise<void> } {
  if (options.enabled === false) return { close: () => Promise.resolve() };
  const logger = options.logger ?? console;
  let closing = false;
  let inFlight: Promise<void> | null = null;
  const scan = () => {
    if (closing || inFlight) return;
    const run = Promise.resolve().then(() => service.scan()).then(() => undefined).catch((error: unknown) => {
      logger.error(JSON.stringify(toSafeRuntimeFailure(error, 'CREATOR_SCHEDULER_SCAN_FAILED', 'database')));
    });
    const tracked = run.finally(() => { if (inFlight === tracked) inFlight = null; });
    inFlight = tracked;
  };
  scan();
  const timer = setInterval(scan, options.intervalMs ?? 10 * 60_000);
  timer.unref();
  return { close: () => { closing = true; clearInterval(timer); return inFlight ?? Promise.resolve(); } };
}
