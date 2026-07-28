import {
  discoveryQueueName,
  type DiscoveryJobData,
} from '@lettermate/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

export interface TopicQueue {
  enqueue(data: DiscoveryJobData): Promise<void>;
  close(): Promise<void>;
}

export class BullTopicQueue implements TopicQueue {
  constructor(
    private readonly queue: Pick<Queue<DiscoveryJobData>, 'add' | 'close'>,
    private readonly redis: Pick<Redis, 'quit'>,
  ) {}

  async enqueue(data: DiscoveryJobData): Promise<void> {
    await this.queue.add('refresh', data, {
      jobId: data.trigger === 'manual'
        ? `manual-${data.topicId}-${randomUUID()}`
        : `${data.trigger}-${data.topicId}`,
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

export function createBullTopicQueue(redisUrl: string): BullTopicQueue {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<DiscoveryJobData>(discoveryQueueName, { connection: redis });
  return new BullTopicQueue(queue, redis);
}
