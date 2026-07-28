import type { TrendJobData } from '@lettermate/contracts';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import {
  TrendDiscoveryService,
  type TrendRepository,
} from './trend-service.js';
import {
  createTrendJobHandler,
  manualTrendFollowUpJobId,
} from './trend-worker.js';

const job = (
  attemptsMade: number,
  trigger: TrendJobData['trigger'] = 'scheduled',
): Job<TrendJobData> => ({
  id: 'job-42',
  data: { userId: 'user-1', trigger },
  attemptsMade,
  opts: { attempts: 3 },
}) as Job<TrendJobData>;

describe('trend job handler', () => {
  it('preserves one pending manual follow-up across a BullMQ retry and terminal success', async () => {
    let active = false;
    let runStatus: 'idle' | 'running' | 'queued' = 'idle';
    let manualPending = false;
    const claimedRunIds: string[] = [];
    const repository: TrendRepository = {
      claimRun: vi.fn(async (_userId, trigger) => {
        if (active) {
          if (trigger === 'manual' && runStatus === 'running') {
            const registered = !manualPending;
            manualPending = true;
            return { state: 'active', followUpManualRegistered: registered } as const;
          }
          if (trigger === 'scheduled' && runStatus === 'queued') {
            runStatus = 'running';
            claimedRunIds.push('run-1');
            return {
              state: 'claimed', runId: 'run-1', monitorId: 'monitor-1', intervalHours: 4,
              nextRunAt: new Date('2026-07-28T16:00:00.000Z'),
            } as const;
          }
          return { state: 'active', followUpManualRegistered: false } as const;
        }
        active = true;
        runStatus = 'running';
        claimedRunIds.push('run-1');
        return {
          state: 'claimed', runId: 'run-1', monitorId: 'monitor-1', intervalHours: 4,
          nextRunAt: new Date('2026-07-28T16:00:00.000Z'),
        } as const;
      }),
      listRecentFingerprints: vi.fn().mockResolvedValue(new Set()),
      saveSeeds: vi.fn().mockResolvedValue(undefined),
      updateSeedQueries: vi.fn().mockResolvedValue(undefined),
      listHistoryUrls: vi.fn().mockResolvedValue([]),
      completeSuccess: vi.fn(async () => {
        active = false;
        runStatus = manualPending ? 'queued' : 'idle';
        return { newItemCount: 0, followUpManual: manualPending };
      }),
      completeFailure: vi.fn(async ({ status }) => {
        if (status === 'queued') {
          runStatus = 'queued';
        } else {
          active = false;
          runStatus = manualPending ? 'queued' : 'idle';
        }
        return { followUpManual: status === 'failed' && manualPending };
      }),
      acknowledgeManualFollowUp: vi.fn(async () => {
        manualPending = false;
        return true;
      }),
    };
    const retryable = new AiGatewayError('AI_RATE_LIMITED', 'Rate limited', true, 1000);
    let sourceAttempt = 0;
    const service = new TrendDiscoveryService({
      repository,
      trendSources: {
        collect: vi.fn(async () => {
          sourceAttempt += 1;
          if (sourceAttempt === 1) {
            await repository.claimRun('user-1', 'manual', new Date());
            throw retryable;
          }
          return {
            candidates: [], successfulSourceIds: ['hacker-news-trends'],
            skippedSourceIds: [], failures: [], requestCount: 1,
            requestCounts: { 'hacker-news-trends': 1 },
          };
        }),
      },
      gateway: { classifyTrendSeeds: vi.fn() },
      connectors: { search: vi.fn() },
      qualityPipeline: { run: vi.fn() },
      timeoutMs: 30_000,
    });
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const handler = createTrendJobHandler(service, queue);

    await expect(handler(job(0))).rejects.toBe(retryable);
    expect(manualPending).toBe(true);
    expect(runStatus).toBe('queued');

    await handler(job(2));

    expect(claimedRunIds).toEqual(['run-1', 'run-1']);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(repository.acknowledgeManualFollowUp).toHaveBeenCalledTimes(1);
    expect(manualPending).toBe(false);
  });

  it('passes retry attempt state to trend discovery and preserves errors', async () => {
    const error = new AiGatewayError('AI_RATE_LIMITED', 'Rate limited', true, 15_000);
    const service = {
      run: vi.fn().mockRejectedValue(error),
      acknowledgeManualFollowUp: vi.fn(),
    } as unknown as Pick<TrendDiscoveryService, 'run' | 'acknowledgeManualFollowUp'>;
    const queue = { add: vi.fn() };

    await expect(createTrendJobHandler(service, queue)(job(0))).rejects.toBe(error);

    expect(service.run).toHaveBeenCalledWith('user-1', 'scheduled', { finalAttempt: false });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('marks the final retry and enqueues one deterministic manual follow-up', async () => {
    const service = {
      run: vi.fn().mockResolvedValue({ followUpManual: true }),
      acknowledgeManualFollowUp: vi.fn().mockResolvedValue(true),
    } as unknown as Pick<TrendDiscoveryService, 'run' | 'acknowledgeManualFollowUp'>;
    const queue = { add: vi.fn().mockResolvedValue(undefined) };

    await createTrendJobHandler(service, queue)(job(2));

    expect(service.run).toHaveBeenCalledWith('user-1', 'scheduled', { finalAttempt: true });
    expect(queue.add).toHaveBeenCalledWith(
      'manual-refresh',
      { userId: 'user-1', trigger: 'manual' },
      expect.objectContaining({
        jobId: manualTrendFollowUpJobId('user-1', 'job-42'),
        attempts: 3,
        backoff: { type: 'custom' },
      }),
    );
    expect(service.acknowledgeManualFollowUp).toHaveBeenCalledWith('user-1');
    expect(queue.add.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(service.acknowledgeManualFollowUp).mock.invocationCallOrder[0]!);
  });

  it('does not clear pending manual state when follow-up enqueue fails', async () => {
    const enqueueError = new Error('Redis unavailable');
    const service = {
      run: vi.fn().mockResolvedValue({ followUpManual: true }),
      acknowledgeManualFollowUp: vi.fn(),
    } as unknown as Pick<TrendDiscoveryService, 'run' | 'acknowledgeManualFollowUp'>;
    const queue = { add: vi.fn().mockRejectedValue(enqueueError) };

    await expect(createTrendJobHandler(service, queue)(job(2))).rejects.toBe(enqueueError);

    expect(service.acknowledgeManualFollowUp).not.toHaveBeenCalled();
  });

  it('rejects invalid job data before running discovery', async () => {
    const service = {
      run: vi.fn(),
      acknowledgeManualFollowUp: vi.fn(),
    } as unknown as Pick<TrendDiscoveryService, 'run' | 'acknowledgeManualFollowUp'>;
    const queue = { add: vi.fn() };
    const invalid = { ...job(0), data: { userId: '', trigger: 'scheduled', unexpected: true } };

    await expect(createTrendJobHandler(service, queue)(invalid as unknown as Job<TrendJobData>))
      .rejects.toThrow();

    expect(service.run).not.toHaveBeenCalled();
  });
});
