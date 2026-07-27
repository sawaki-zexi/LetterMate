import { type DiscoveryJobData, type DiscoveryTrigger } from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';

export interface TopicScheduleState {
  scheduleIntervalHours: 6 | 12 | 24;
  productiveRunStreak: number;
  emptyRunStreak: number;
}

export interface TopicScheduleUpdate extends TopicScheduleState {
  nextRunAt: Date;
}

const deterministicJitter = (topicId: string): number => {
  let hash = 2166136261;
  for (const character of topicId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash) % 2001 - 1000) / 10_000;
};

export function calculateScheduleUpdate(input: {
  topicId: string;
  trigger: Exclude<DiscoveryTrigger, 'manual'>;
  newItemCount: number;
  state: TopicScheduleState;
  finishedAt: Date;
}): TopicScheduleUpdate {
  let scheduleIntervalHours: 6 | 12 | 24 = 12;
  let productiveRunStreak = 0;
  let emptyRunStreak = 0;
  if (input.trigger === 'scheduled') {
    if (input.newItemCount >= 2) {
      productiveRunStreak = input.state.productiveRunStreak + 1;
      scheduleIntervalHours = productiveRunStreak >= 2 ? 6 : 12;
    } else if (input.newItemCount === 0) {
      emptyRunStreak = input.state.emptyRunStreak + 1;
      scheduleIntervalHours = emptyRunStreak >= 2 ? 24 : 12;
    }
  }
  const intervalMs = scheduleIntervalHours * 60 * 60 * 1_000;
  return {
    nextRunAt: new Date(
      input.finishedAt.getTime() + Math.round(
        intervalMs * (1 + deterministicJitter(input.topicId)),
      ),
    ),
    scheduleIntervalHours,
    productiveRunStreak,
    emptyRunStreak,
  };
}

export function calculateFailureSchedule(finishedAt: Date): TopicScheduleUpdate {
  return {
    nextRunAt: new Date(finishedAt.getTime() + 24 * 60 * 60 * 1_000),
    scheduleIntervalHours: 24,
    productiveRunStreak: 0,
    emptyRunStreak: 0,
  };
}

export interface ClaimedTopic {
  topicId: string;
  userId: string;
  dueAt: Date;
}

export interface TopicScheduleRepository {
  claimDueTopics(now: Date, claimUntil: Date, limit: number): Promise<ClaimedTopic[]>;
}

export class PrismaTopicScheduleRepository implements TopicScheduleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claimDueTopics(now: Date, claimUntil: Date, limit: number): Promise<ClaimedTopic[]> {
    const dueTopics = await this.prisma.topic.findMany({
      where: {
        OR: [
          {
            nextRunAt: { lte: now },
            OR: [
              { runStatus: { not: 'running' } },
              { runLeaseUntil: null },
              { runLeaseUntil: { lte: now } },
            ],
          },
          { runStatus: 'running', runLeaseUntil: { lte: now } },
        ],
      },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        userId: true,
        nextRunAt: true,
        runStatus: true,
        runLeaseUntil: true,
      },
    });
    const claimed: ClaimedTopic[] = [];
    for (const topic of dueTopics) {
      const staleRun = topic.runStatus === 'running' &&
        topic.runLeaseUntil !== null &&
        topic.runLeaseUntil <= now;
      const dueAt = staleRun ? topic.runLeaseUntil : topic.nextRunAt;
      if (!dueAt) continue;
      const result = await this.prisma.topic.updateMany({
        where: staleRun
          ? {
              id: topic.id,
              runStatus: 'running',
              runLeaseUntil: topic.runLeaseUntil,
            }
          : {
              id: topic.id,
              nextRunAt: topic.nextRunAt,
              OR: [
                { runStatus: { not: 'running' } },
                { runLeaseUntil: null },
                { runLeaseUntil: { lte: now } },
              ],
            },
        data: {
          nextRunAt: claimUntil,
          runStatus: 'queued',
        },
      });
      if (result.count === 1) {
        claimed.push({ topicId: topic.id, userId: topic.userId, dueAt });
      }
    }
    return claimed;
  }
}

interface ScheduleQueue {
  add(
    name: string,
    data: DiscoveryJobData,
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: string };
      removeOnComplete: boolean;
      removeOnFail: boolean;
    },
  ): Promise<unknown>;
}

export interface TopicScheduleServiceOptions {
  claimLeaseMs: number;
  limit: number;
}

const defaultOptions: TopicScheduleServiceOptions = {
  claimLeaseMs: 10 * 60 * 1_000,
  limit: 50,
};

export const scheduledJobId = (topicId: string, dueAt: Date) => (
  `scheduled-${topicId}-${dueAt.getTime()}`
);

export class TopicScheduleService {
  private readonly options: TopicScheduleServiceOptions;

  constructor(
    private readonly repository: TopicScheduleRepository,
    private readonly queue: ScheduleQueue,
    options: Partial<TopicScheduleServiceOptions> = {},
  ) {
    this.options = { ...defaultOptions, ...options };
  }

  async scan(now = new Date()): Promise<number> {
    const claimUntil = new Date(now.getTime() + this.options.claimLeaseMs);
    const topics = await this.repository.claimDueTopics(
      now,
      claimUntil,
      this.options.limit,
    );
    await Promise.all(topics.map((topic) => this.queue.add(
      'scheduled-refresh',
      { topicId: topic.topicId, userId: topic.userId, trigger: 'scheduled' },
      {
        jobId: scheduledJobId(topic.topicId, topic.dueAt),
        attempts: 3,
        backoff: { type: 'custom' },
        removeOnComplete: true,
        removeOnFail: true,
      },
    )));
    return topics.length;
  }
}

export function startTopicScheduler(
  service: Pick<TopicScheduleService, 'scan'>,
  intervalMs = 10 * 60 * 1_000,
): { close(): void } {
  void service.scan();
  const timer = setInterval(() => void service.scan(), intervalMs);
  timer.unref();
  return { close: () => clearInterval(timer) };
}
