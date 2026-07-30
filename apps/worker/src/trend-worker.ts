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
import { z } from 'zod';
import type { TrendDiscoveryService } from './trend-service.js';
import type { LegacyTrendJobData } from './trend-service.js';
import { backoffStrategy } from './worker.js';

interface TrendWorkerQueue {
  add(
    name: string,
    data: TrendJobData,
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: string };
      removeOnComplete: { age: number; count: number };
      removeOnFail: { age: number; count: number };
    },
  ): Promise<unknown>;
}

export const manualTrendFollowUpJobId = (runId: string): string =>
  `manual-trend-follow-up-${runId}`;

const legacyTrendJobDataSchema = z.strictObject({
  userId: z.string().min(1),
  trigger: z.enum(['manual', 'scheduled']),
});

export function createTrendJobHandler(
  service: Pick<TrendDiscoveryService, 'run' | 'acknowledgeManualFollowUp'>,
  queue: TrendWorkerQueue,
) {
  return async (job: Job<TrendJobData>): Promise<void> => {
    const parsed = trendJobDataSchema.safeParse(job.data);
    const data: TrendJobData | LegacyTrendJobData = parsed.success
      ? parsed.data
      : legacyTrendJobDataSchema.parse(job.data);
    const attempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    const result = await service.run(data, { finalAttempt });
    if (!result.followUpManualRunId) return;
    const followUpRunId = result.followUpManualRunId;
    await queue.add(
      'manual-refresh',
      { userId: data.userId, trigger: 'manual', runId: followUpRunId },
      {
        jobId: manualTrendFollowUpJobId(followUpRunId),
        attempts: 3,
        backoff: { type: 'custom' },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3_600, count: 1_000 },
      },
    );
    await service.acknowledgeManualFollowUp(data.userId, followUpRunId);
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
