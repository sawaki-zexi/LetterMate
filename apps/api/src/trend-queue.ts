import { trendQueueName, type TrendJobData } from '@lettermate/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';

type ManualTrendJobData = Extract<TrendJobData, { trigger: 'manual' }>;

export interface TrendQueue {
  enqueue(data: ManualTrendJobData): Promise<void>;
  close(): Promise<void>;
  healthCheck?(): Promise<void>;
}

type RedisConnection = Pick<Redis, 'quit'> & Partial<Pick<Redis, 'ping'>>;

export const manualTrendJobId = (runId: string): string =>
  `manual-trend-${createHash('sha256').update(runId).digest('hex')}`;

const completedRetention = { age: 3_600, count: 1_000 } as const;
const failedRetention = { age: 7 * 24 * 3_600, count: 1_000 } as const;

export class BullTrendQueue implements TrendQueue {
  constructor(
    private readonly queue: Pick<Queue<ManualTrendJobData>, 'add' | 'close'>,
    private readonly redis: RedisConnection,
  ) {}

  async enqueue(data: ManualTrendJobData): Promise<void> {
    await this.queue.add('manual-refresh', data, {
      jobId: manualTrendJobId(data.runId),
      attempts: 3,
      backoff: { type: 'custom' },
      removeOnComplete: completedRetention,
      removeOnFail: failedRetention,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.redis.quit();
  }

  async healthCheck(): Promise<void> {
    if (!this.redis.ping) throw new Error('Redis health probe is unavailable');
    await this.redis.ping();
  }
}

export function createBullTrendQueue(redisUrl: string): BullTrendQueue {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<ManualTrendJobData>(trendQueueName, { connection: redis });
  return new BullTrendQueue(queue, redis);
}
