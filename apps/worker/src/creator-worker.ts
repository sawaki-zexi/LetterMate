import { creatorJobDataSchema, creatorQueueName, type CreatorJobData } from '@lettermate/contracts';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { CreatorDiscoveryService } from './creator-service.js';
import { backoffStrategy } from './worker.js';

export function createCreatorJobHandler(service: Pick<CreatorDiscoveryService, 'run'>) {
  return async (job: Job<CreatorJobData>): Promise<void> => {
    const data = creatorJobDataSchema.parse(job.data);
    const attempts = job.opts.attempts ?? 1;
    await service.run(data, { finalAttempt: job.attemptsMade + 1 >= attempts });
  };
}

export function createCreatorWorker(
  connection: ConnectionOptions,
  service: Pick<CreatorDiscoveryService, 'run'>,
): Worker<CreatorJobData> {
  return new Worker<CreatorJobData>(creatorQueueName, createCreatorJobHandler(service), {
    connection,
    settings: { backoffStrategy },
  });
}
