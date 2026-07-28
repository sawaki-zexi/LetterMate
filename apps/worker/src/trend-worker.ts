import {
  trendJobDataSchema,
  trendQueueName,
  type TrendJobData,
} from '@lettermate/contracts';
import {
  Worker,
  type ConnectionOptions,
  type Job,
} from 'bullmq';
import type { TrendDiscoveryService } from './trend-service.js';
import { backoffStrategy } from './worker.js';

interface TrendWorkerQueue {
  add(
    name: string,
    data: TrendJobData,
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: string };
      removeOnComplete: boolean;
      removeOnFail: boolean;
    },
  ): Promise<unknown>;
}

export const manualTrendFollowUpJobId = (userId: string, parentJobId: string): string =>
  `manual-trend-follow-up-${userId}-${parentJobId}`;

export function createTrendJobHandler(
  service: Pick<TrendDiscoveryService, 'run' | 'acknowledgeManualFollowUp'>,
  queue: TrendWorkerQueue,
) {
  return async (job: Job<TrendJobData>): Promise<void> => {
    const data = trendJobDataSchema.parse(job.data);
    const attempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    const result = await service.run(data.userId, data.trigger, { finalAttempt });
    if (!result.followUpManual) return;
    const parentJobId = String(job.id ?? job.timestamp);
    await queue.add(
      'manual-refresh',
      { userId: data.userId, trigger: 'manual' },
      {
        jobId: manualTrendFollowUpJobId(data.userId, parentJobId),
        attempts: 3,
        backoff: { type: 'custom' },
        removeOnComplete: false,
        removeOnFail: true,
      },
    );
    await service.acknowledgeManualFollowUp(data.userId);
  };
}

export function createTrendWorker(
  connection: ConnectionOptions,
  service: Pick<TrendDiscoveryService, 'run' | 'acknowledgeManualFollowUp'>,
  queue: TrendWorkerQueue,
): Worker<TrendJobData> {
  return new Worker<TrendJobData>(
    trendQueueName,
    createTrendJobHandler(service, queue),
    { connection, settings: { backoffStrategy } },
  );
}
