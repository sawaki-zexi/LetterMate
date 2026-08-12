import { digestTestEmailQueueName, type DigestTestEmailJobData } from '@lettermate/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export interface DigestTestEmailQueue {
  enqueue(data: DigestTestEmailJobData): Promise<void>;
  close(): Promise<void>;
  healthCheck?(): Promise<void>;
}

export class MemoryDigestTestEmailQueue implements DigestTestEmailQueue {
  readonly jobs: DigestTestEmailJobData[] = [];
  async enqueue(data: DigestTestEmailJobData): Promise<void> {
    this.jobs.push(structuredClone(data));
  }
  async close(): Promise<void> {}
}

type RedisConnection = Pick<Redis, 'quit'> & Partial<Pick<Redis, 'ping'>>;

export class BullDigestTestEmailQueue implements DigestTestEmailQueue {
  constructor(
    private readonly queue: Pick<Queue<DigestTestEmailJobData>, 'add' | 'close'>,
    private readonly redis: RedisConnection,
  ) {}

  async enqueue(data: DigestTestEmailJobData): Promise<void> {
    await this.queue.add('send-test-email', data, {
      jobId: `digest-test-${data.testEmailId}`,
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

export function createBullDigestTestEmailQueue(redisUrl: string): BullDigestTestEmailQueue {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<DigestTestEmailJobData>(digestTestEmailQueueName, { connection: redis });
  return new BullDigestTestEmailQueue(queue, redis);
}
