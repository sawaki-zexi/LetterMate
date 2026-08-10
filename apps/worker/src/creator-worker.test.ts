import type { CreatorJobData } from '@lettermate/contracts';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import type { CreatorDiscoveryService } from './creator-service.js';
import { createCreatorJobHandler } from './creator-worker.js';

const job = (attemptsMade: number): Job<CreatorJobData> => ({
  data: { creatorId: 'creator-1', userId: 'user-1', trigger: 'scheduled' },
  attemptsMade,
  opts: { attempts: 3 },
}) as Job<CreatorJobData>;

describe('creator job handler', () => {
  it('preserves retryable failures and attempt state', async () => {
    const error = new AiGatewayError('AI_RATE_LIMITED', 'Rate limited', true);
    const service = {
      run: vi.fn().mockRejectedValue(error),
    } as unknown as Pick<CreatorDiscoveryService, 'run'>;

    await expect(createCreatorJobHandler(service)(job(0))).rejects.toBe(error);
    expect(service.run).toHaveBeenCalledWith(job(0).data, { finalAttempt: false });
  });

  it('stops BullMQ retries for an explicit non-retryable provider failure', async () => {
    const error = new AiGatewayError('AI_AUTH_FAILED', 'Private provider message', false);
    const service = {
      run: vi.fn().mockRejectedValue(error),
    } as unknown as Pick<CreatorDiscoveryService, 'run'>;

    await expect(createCreatorJobHandler(service)(job(0))).rejects.toMatchObject({
      name: 'CodedUnrecoverableError',
      code: 'AI_AUTH_FAILED',
    });
  });
});
