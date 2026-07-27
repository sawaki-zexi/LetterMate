import {
  discoveryQueueName,
  type DiscoveryJobData,
} from '@lettermate/contracts';
import {
  Worker,
  type BackoffStrategy,
  type ConnectionOptions,
  type Job,
} from 'bullmq';
import { AiGatewayError } from './ai-gateway.js';
import type { TopicDiscoveryService } from './discovery-service.js';

export const backoffStrategy: BackoffStrategy = (attemptsMade, _type, error) => {
  if (error instanceof AiGatewayError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return Math.min(1_000 * 2 ** Math.max(0, attemptsMade), 300_000);
};

export function createDiscoveryJobHandler(
  service: Pick<TopicDiscoveryService, 'run'>,
) {
  return async (job: Job<DiscoveryJobData>): Promise<void> => {
    const attempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    await service.run(
      job.data.topicId,
      job.data.userId,
      job.data.trigger,
      { finalAttempt },
    );
  };
}

export function createDiscoveryWorker(
  connection: ConnectionOptions,
  service: Pick<TopicDiscoveryService, 'run'>,
): Worker<DiscoveryJobData> {
  return new Worker<DiscoveryJobData>(
    discoveryQueueName,
    createDiscoveryJobHandler(service),
    { connection, settings: { backoffStrategy } },
  );
}
