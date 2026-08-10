import type { DiscoveryJobData } from '@lettermate/contracts';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import type { TopicDiscoveryService } from './discovery-service.js';
import { backoffStrategy, createDiscoveryJobHandler } from './worker.js';

const job = (attemptsMade: number, trigger: DiscoveryJobData['trigger'] = 'scheduled'): Job<DiscoveryJobData> =>
  ({
    data: { topicId: 'topic-1', userId: 'user-a', trigger },
    attemptsMade,
    opts: { attempts: 3 },
  }) as Job<DiscoveryJobData>;

describe('discovery job handler', () => {
  it('passes a retrying scheduled attempt to the service', async () => {
    const error = new AiGatewayError('AI_RATE_LIMITED', 'Rate limited', true, 15_000);
    const service = {
      run: vi.fn().mockRejectedValue(error),
    } as unknown as Pick<TopicDiscoveryService, 'run'>;

    await expect(createDiscoveryJobHandler(service)(job(0))).rejects.toBe(error);

    expect(service.run).toHaveBeenCalledWith(
      'topic-1',
      'user-a',
      'scheduled',
      { finalAttempt: false },
    );
  });

  it('marks the last attempt for final scheduled failure handling', async () => {
    const error = new AiGatewayError('AI_RATE_LIMITED', 'Rate limited', true, 15_000);
    const service = {
      run: vi.fn().mockRejectedValue(error),
    } as unknown as Pick<TopicDiscoveryService, 'run'>;

    await expect(createDiscoveryJobHandler(service)(job(2))).rejects.toBe(error);

    expect(service.run).toHaveBeenCalledWith(
      'topic-1',
      'user-a',
      'scheduled',
      { finalAttempt: true },
    );
  });

  it('stops BullMQ retries for an explicit non-retryable provider failure', async () => {
    const error = new AiGatewayError('AI_AUTH_FAILED', 'Private provider message', false);
    const service = {
      run: vi.fn().mockRejectedValue(error),
    } as unknown as Pick<TopicDiscoveryService, 'run'>;

    await expect(createDiscoveryJobHandler(service)(job(0))).rejects.toMatchObject({
      name: 'CodedUnrecoverableError',
      code: 'AI_AUTH_FAILED',
    });
    expect(service.run).toHaveBeenCalledWith(
      'topic-1', 'user-a', 'scheduled', { finalAttempt: false },
    );
  });

  it('preserves a manual trigger', async () => {
    const service = {
      run: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pick<TopicDiscoveryService, 'run'>;

    await createDiscoveryJobHandler(service)(job(0, 'manual'));

    expect(service.run).toHaveBeenCalledWith(
      'topic-1',
      'user-a',
      'manual',
      { finalAttempt: false },
    );
  });
});

describe('worker backoff strategy', () => {
  it('honors Retry-After before exponential fallback', () => {
    expect(backoffStrategy(
      1,
      'custom',
      new AiGatewayError('AI_RATE_LIMITED', 'Rate limited', true, 15_000),
    )).toBe(15_000);
    expect(backoffStrategy(2, 'custom', new Error('network'))).toBe(4_000);
  });
});
