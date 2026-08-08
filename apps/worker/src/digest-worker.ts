import {
  digestJobDataSchema,
  digestQueueName,
  type DigestJobData,
} from '@lettermate/contracts';
import {
  Worker,
  type BackoffStrategy,
  type ConnectionOptions,
  type Job,
} from 'bullmq';
import { EmailGatewayError } from './digest-email.js';
import type { DigestDeliveryService } from './digest-service.js';

export const digestBackoffStrategy: BackoffStrategy = (attemptsMade, _type, error) => {
  if (error instanceof EmailGatewayError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return Math.min(5_000 * 2 ** Math.max(0, attemptsMade - 1), 5 * 60_000);
};

export function createDigestJobHandler(service: Pick<DigestDeliveryService, 'run'>) {
  return async (job: Job<DigestJobData>): Promise<void> => {
    const attempts = job.opts.attempts ?? 1;
    await service.run(digestJobDataSchema.parse(job.data), {
      finalAttempt: job.attemptsMade + 1 >= attempts,
    });
  };
}

export function createDigestWorker(
  connection: ConnectionOptions,
  service: Pick<DigestDeliveryService, 'run'>,
): Worker<DigestJobData> {
  return new Worker<DigestJobData>(digestQueueName, createDigestJobHandler(service), {
    connection,
    settings: { backoffStrategy: digestBackoffStrategy },
  });
}
