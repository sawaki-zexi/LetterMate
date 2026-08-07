import { creatorQueueName, type CreatorJobData } from '@lettermate/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export interface CreatorQueue {
  enqueue(data: CreatorJobData): Promise<void>;
  close(): Promise<void>;
  healthCheck?(): Promise<void>;
}

type RedisConnection = Pick<Redis, 'quit'> & Partial<Pick<Redis, 'ping'>>;

export class BullCreatorQueue implements CreatorQueue {
  constructor(
    private readonly queue: Pick<Queue<CreatorJobData>, 'add' | 'close'>,
    private readonly redis: RedisConnection,
  ) {}

  async enqueue(data: CreatorJobData): Promise<void> {
    await this.queue.add('refresh', data, {
      jobId: `${data.trigger}-${data.creatorId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: true,
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

export function createBullCreatorQueue(redisUrl: string): BullCreatorQueue {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<CreatorJobData>(creatorQueueName, { connection: redis });
  return new BullCreatorQueue(queue, redis);
}
