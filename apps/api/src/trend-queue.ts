import { trendQueueName, type TrendJobData } from '@lettermate/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';

export interface TrendQueue {
  enqueue(data: TrendJobData): Promise<void>;
  close(): Promise<void>;
}

export const manualTrendJobId = (userId: string): string =>
  `manual-trend-${createHash('sha256').update(userId).digest('hex')}`;

export class BullTrendQueue implements TrendQueue {
  constructor(
    private readonly queue: Pick<Queue<TrendJobData>, 'add' | 'close'>,
    private readonly redis: Pick<Redis, 'quit'>,
  ) {}

  async enqueue(data: TrendJobData): Promise<void> {
    await this.queue.add('manual-refresh', data, {
      jobId: manualTrendJobId(data.userId),
      attempts: 3,
      backoff: { type: 'custom' },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.redis.quit();
  }
}

export function createBullTrendQueue(redisUrl: string): BullTrendQueue {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<TrendJobData>(trendQueueName, { connection: redis });
  return new BullTrendQueue(queue, redis);
}
