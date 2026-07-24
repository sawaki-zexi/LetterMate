import type { DiscoveryJobData } from '@lettermate/contracts';
import {
  Worker,
  type BackoffStrategy,
  type ConnectionOptions,
  type Job,
} from 'bullmq';
import { AiGatewayError } from './ai-gateway.js';
import {
  toSafeAiError,
  type DiscoveryRepository,
  type TopicDiscoveryService,
} from './discovery-service.js';

export const DISCOVERY_QUEUE_NAME = 'topic-discovery';

export const backoffStrategy: BackoffStrategy = (attemptsMade, _type, error) => {
  if (error instanceof AiGatewayError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return Math.min(1_000 * 2 ** Math.max(0, attemptsMade), 300_000);
};

export function createDiscoveryJobHandler(
  service: Pick<TopicDiscoveryService, 'run'>,
  repository: Pick<DiscoveryRepository, 'saveFailure'>,
) {
  return async (job: Job<DiscoveryJobData>): Promise<void> => {
    try {
      await service.run(job.data.topicId, job.data.userId);
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      const hasAnotherAttempt = job.attemptsMade + 1 < attempts;
      if (error instanceof AiGatewayError && error.retryable && hasAnotherAttempt) {
        await repository.saveFailure(
          job.data.topicId,
          toSafeAiError(error),
          new Date(),
          'queued',
        );
      }
      throw error;
    }
  };
}

export function createDiscoveryWorker(
  connection: ConnectionOptions,
  service: Pick<TopicDiscoveryService, 'run'>,
  repository: Pick<DiscoveryRepository, 'saveFailure'>,
): Worker<DiscoveryJobData> {
  return new Worker<DiscoveryJobData>(
    DISCOVERY_QUEUE_NAME,
    createDiscoveryJobHandler(service, repository),
    { connection, settings: { backoffStrategy } },
  );
}
