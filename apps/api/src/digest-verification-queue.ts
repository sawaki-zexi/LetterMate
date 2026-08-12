import {
  digestVerificationQueueName,
  type DigestVerificationJobData,
} from '@lettermate/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export interface DigestVerificationQueue {
  enqueue(data: DigestVerificationJobData): Promise<void>;
  close(): Promise<void>;
  healthCheck?(): Promise<void>;
}

export class MemoryDigestVerificationQueue implements DigestVerificationQueue {
  readonly jobs: DigestVerificationJobData[] = [];

  async enqueue(data: DigestVerificationJobData): Promise<void> {
    this.jobs.push(structuredClone(data));
  }

  async close(): Promise<void> {}
}

type RedisConnection = Pick<Redis, 'quit'> & Partial<Pick<Redis, 'ping'>>;

export class BullDigestVerificationQueue implements DigestVerificationQueue {
  constructor(
    private readonly queue: Pick<Queue<DigestVerificationJobData>, 'add' | 'close'>,
    private readonly redis: RedisConnection,
  ) {}

  async enqueue(data: DigestVerificationJobData): Promise<void> {
    await this.queue.add('send-verification', data, {
      jobId: data.verificationId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600, count: 1_000 },
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

export function createBullDigestVerificationQueue(redisUrl: string): BullDigestVerificationQueue {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<DigestVerificationJobData>(digestVerificationQueueName, {
    connection: redis,
  });
  return new BullDigestVerificationQueue(queue, redis);
}
