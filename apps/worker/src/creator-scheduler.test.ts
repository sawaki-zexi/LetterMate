import { describe, expect, it, vi } from 'vitest';
import {
  CreatorScheduleService,
  scheduledCreatorJobId,
  type ClaimedCreator,
  type CreatorScheduleRepository,
} from './creator-scheduler.js';

const creator: ClaimedCreator = {
  creatorId: 'creator-1',
  userId: 'user-1',
  dueAt: new Date('2026-08-06T00:00:00.000Z'),
  claimUntil: new Date('2026-08-06T00:10:00.000Z'),
};

describe('creator scheduler', () => {
  it('enqueues one deterministic daily creator job', async () => {
    const repository: CreatorScheduleRepository = {
      claimDueCreators: vi.fn().mockResolvedValue([creator]),
      releaseClaim: vi.fn().mockResolvedValue(true),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const service = new CreatorScheduleService(repository, queue);

    expect(await service.scan(new Date('2026-08-06T00:00:00.000Z'))).toBe(1);
    expect(queue.add).toHaveBeenCalledWith('scheduled-refresh', {
      creatorId: 'creator-1', userId: 'user-1', trigger: 'scheduled',
    }, expect.objectContaining({
      jobId: scheduledCreatorJobId('creator-1', creator.dueAt),
    }));
  });

  it('releases a database claim when Redis enqueue fails', async () => {
    const repository: CreatorScheduleRepository = {
      claimDueCreators: vi.fn().mockResolvedValue([creator]),
      releaseClaim: vi.fn().mockResolvedValue(true),
    };
    const queue = { add: vi.fn().mockRejectedValue(new Error('redis unavailable')) };
    const logger = { error: vi.fn() };
    const service = new CreatorScheduleService(repository, queue, {
      claimLeaseMs: 600_000,
      limit: 50,
      logger,
    });

    expect(await service.scan(new Date('2026-08-06T00:00:00.000Z'))).toBe(0);
    expect(repository.releaseClaim).toHaveBeenCalledWith(creator);
    expect(logger.error).toHaveBeenCalled();
  });
});
