import type { TrendJobData } from '@lettermate/contracts';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import type { TrendDiscoveryService } from './trend-service.js';
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
  it('passes retry attempt state to trend discovery and preserves errors', async () => {
    const error = new AiGatewayError('AI_RATE_LIMITED', 'Rate limited', true, 15_000);
    const service = { run: vi.fn().mockRejectedValue(error) } as unknown as Pick<TrendDiscoveryService, 'run'>;
    const queue = { add: vi.fn() };

    await expect(createTrendJobHandler(service, queue)(job(0))).rejects.toBe(error);

    expect(service.run).toHaveBeenCalledWith('user-1', 'scheduled', { finalAttempt: false });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('marks the final retry and enqueues one deterministic manual follow-up', async () => {
    const service = {
      run: vi.fn().mockResolvedValue({ followUpManual: true }),
    } as unknown as Pick<TrendDiscoveryService, 'run'>;
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
  });

  it('rejects invalid job data before running discovery', async () => {
    const service = { run: vi.fn() } as unknown as Pick<TrendDiscoveryService, 'run'>;
    const queue = { add: vi.fn() };
    const invalid = { ...job(0), data: { userId: '', trigger: 'scheduled', unexpected: true } };

    await expect(createTrendJobHandler(service, queue)(invalid as unknown as Job<TrendJobData>))
      .rejects.toThrow();

    expect(service.run).not.toHaveBeenCalled();
  });
});
