import type { DiscoveryJobData, SafeError } from '@lettermate/contracts';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import type { DiscoveryRepository, TopicDiscoveryService } from './discovery-service.js';
import {
  backoffStrategy,
  createDiscoveryJobHandler,
} from './worker.js';

const job = (attemptsMade: number): Job<DiscoveryJobData> =>
  ({
    data: { topicId: 'topic-1', userId: 'user-a' },
    attemptsMade,
    opts: { attempts: 3 },
  }) as Job<DiscoveryJobData>;

describe('discovery job handler', () => {
  it('requeues a retryable failure before the final attempt', async () => {
    const error = new AiGatewayError('AI_RATE_LIMITED', '限流', true, 15_000);
    const service = { run: vi.fn().mockRejectedValue(error) } as unknown as TopicDiscoveryService;
    const saveFailure = vi.fn();
    const repository = { saveFailure } as unknown as DiscoveryRepository;
    const handler = createDiscoveryJobHandler(service, repository);

    await expect(handler(job(0))).rejects.toBe(error);

    expect(saveFailure).toHaveBeenCalledWith(
      'topic-1',
      { code: 'AI_RATE_LIMITED', message: '限流' } satisfies SafeError,
      expect.any(Date),
      'queued',
    );
  });

  it('leaves the service failure final on the last attempt', async () => {
    const error = new AiGatewayError('AI_RATE_LIMITED', '限流', true, 15_000);
    const service = { run: vi.fn().mockRejectedValue(error) } as unknown as TopicDiscoveryService;
    const saveFailure = vi.fn();
    const repository = { saveFailure } as unknown as DiscoveryRepository;

    await expect(createDiscoveryJobHandler(service, repository)(job(2))).rejects.toBe(error);

    expect(saveFailure).not.toHaveBeenCalled();
  });
});

describe('worker backoff strategy', () => {
  it('honors Retry-After before exponential fallback', () => {
    expect(backoffStrategy(1, 'custom', new AiGatewayError('AI_RATE_LIMITED', '限流', true, 15_000))).toBe(15_000);
    expect(backoffStrategy(2, 'custom', new Error('network'))).toBe(4_000);
  });
});
