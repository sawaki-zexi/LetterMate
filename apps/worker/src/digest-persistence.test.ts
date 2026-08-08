import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  type ClaimedDigestRun,
  PrismaDigestDeliveryRepository,
  PrismaDigestScheduleRepository,
} from './digest-service.js';

const now = new Date('2026-08-08T00:30:00.000Z');
const claimedRun: ClaimedDigestRun = {
  runId: 'run-1', userId: 'user-a', scheduledLocalDate: '2026-08-08',
  recipient: 'student@example.com',
  leaseUntil: new Date('2026-08-08T00:40:00.000Z'),
  items: [{
    contentKey: 'https://example.com/1', position: 0, title: '标题',
    summary: '摘要', reason: '理由', sourceUrl: 'https://example.com/1',
  }],
};

describe('PrismaDigestScheduleRepository', () => {
  it('reuses a queued run for safe re-entry without replacing its frozen snapshot', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      digestRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'run-existing', status: 'queued', runLeaseUntil: null,
        }),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => (
        callback(transaction)
      )),
    } as unknown as PrismaClient;

    await expect(new PrismaDigestScheduleRepository(prisma).ensureRun({
      userId: 'user-a', scheduledLocalDate: '2026-08-08', windowEnd: now, now,
    })).resolves.toEqual({
      runId: 'run-existing', userId: 'user-a', status: 'queued',
    });

    expect(transaction.digestRun.findFirst).not.toHaveBeenCalled();
    expect(transaction.digestRun.create).not.toHaveBeenCalled();
  });

  it('requeues the same stale running snapshot after its lease expires', async () => {
    const staleLease = new Date('2026-08-08T00:20:00.000Z');
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      digestRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'run-stale', status: 'running', runLeaseUntil: staleLease,
        }),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => (
        callback(transaction)
      )),
    } as unknown as PrismaClient;

    await expect(new PrismaDigestScheduleRepository(prisma).ensureRun({
      userId: 'user-a', scheduledLocalDate: '2026-08-08', windowEnd: now, now,
    })).resolves.toEqual({
      runId: 'run-stale', userId: 'user-a', status: 'queued',
    });
    expect(transaction.digestRun.create).not.toHaveBeenCalled();
  });

  it('creates an owned skipped run at the latest succeeded or skipped boundary', async () => {
    const boundary = new Date('2026-08-07T00:30:00.000Z');
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      digestRun: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue({ windowEnd: boundary }),
        create: vi.fn().mockResolvedValue({ id: 'run-empty' }),
      },
      discoveryItem: { findMany: vi.fn().mockResolvedValue([]) },
      radarItem: { findMany: vi.fn().mockResolvedValue([]) },
      creatorItem: { findMany: vi.fn().mockResolvedValue([]) },
      digestItem: { findMany: vi.fn().mockResolvedValue([]) },
      interestMemorySettings: { findUnique: vi.fn().mockResolvedValue(null) },
      userInterestProfile: { findMany: vi.fn().mockResolvedValue([]) },
      forgottenInterestTag: { findMany: vi.fn().mockResolvedValue([]) },
      contentInterestTag: { findMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => (
        callback(transaction)
      )),
    } as unknown as PrismaClient;

    const result = await new PrismaDigestScheduleRepository(prisma).ensureRun({
      userId: 'user-a', scheduledLocalDate: '2026-08-08', windowEnd: now, now,
    });

    expect(result).toEqual({ runId: 'run-empty', userId: 'user-a', status: 'skipped' });
    expect(transaction.digestRun.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-a', status: { in: ['succeeded', 'skipped'] } },
      select: { windowEnd: true },
      orderBy: [{ windowEnd: 'desc' }, { id: 'desc' }],
    });
    expect(transaction.discoveryItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ topic: { userId: 'user-a' } }),
    }));
    expect(transaction.radarItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'user-a' }),
    }));
    expect(transaction.creatorItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'user-a', feedEligible: true }),
    }));
    expect(transaction.digestItem.findMany).toHaveBeenCalledWith({
      where: { run: { userId: 'user-a', status: 'succeeded' } },
      select: { contentKey: true },
    });
    expect(transaction.digestRun.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-a',
        scheduledLocalDate: '2026-08-08',
        windowStart: boundary,
        windowEnd: now,
        status: 'skipped',
        finishedAt: now,
      },
      select: { id: true },
    });
    expect(transaction.contentInterestTag.findMany).not.toHaveBeenCalled();
  });
});

describe('PrismaDigestDeliveryRepository', () => {
  it('claims only the owned queued or stale run with a persisted lease', async () => {
    const leaseUntil = new Date('2026-08-08T00:40:00.000Z');
    const prisma = {
      digestRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          id: 'run-1', userId: 'user-a', scheduledLocalDate: '2026-08-08',
          user: { email: 'student@example.com' }, items: [],
        }),
      },
    } as unknown as PrismaClient;

    const claimed = await new PrismaDigestDeliveryRepository(prisma).claim(
      { runId: 'run-1', userId: 'user-a' }, now, leaseUntil,
    );

    expect(claimed).toMatchObject({
      runId: 'run-1', userId: 'user-a', recipient: 'student@example.com', leaseUntil,
    });
    expect(prisma.digestRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'run-1', userId: 'user-a',
        OR: [
          { status: 'queued' },
          { status: 'running', runLeaseUntil: { lte: now } },
        ],
      },
      data: expect.objectContaining({
        status: 'running', startedAt: now, runLeaseUntil: leaseUntil,
        attemptCount: { increment: 1 },
      }),
    }));
  });

  it('allows only one concurrent consumer to acquire the run lease', async () => {
    const prisma = {
      digestRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(),
      },
    } as unknown as PrismaClient;

    await expect(new PrismaDigestDeliveryRepository(prisma).claim(
      { runId: 'run-1', userId: 'user-a' },
      now,
      claimedRun.leaseUntil,
    )).resolves.toBeNull();
    expect(prisma.digestRun.findUnique).not.toHaveBeenCalled();
  });

  it('persists retryable and terminal errors without provider details or credentials', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      digestRun: { updateMany },
    } as unknown as PrismaClient;
    const repository = new PrismaDigestDeliveryRepository(prisma);

    await repository.retry(claimedRun, 'EMAIL_RATE_LIMITED');
    await repository.fail(claimedRun, 'provider said token=secret', now);

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'run-1', userId: 'user-a', status: 'running',
        runLeaseUntil: claimedRun.leaseUntil,
      },
      data: {
        status: 'queued', finishedAt: null, runLeaseUntil: null,
        error: {
          code: 'EMAIL_RATE_LIMITED',
          message: 'Daily digest delivery will be retried',
        },
      },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'run-1', userId: 'user-a', status: 'running',
        runLeaseUntil: claimedRun.leaseUntil,
      },
      data: {
        status: 'failed', finishedAt: now, runLeaseUntil: null,
        error: {
          code: 'EMAIL_GATEWAY_UNAVAILABLE',
          message: 'Daily digest delivery failed',
        },
      },
    });
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain('secret');
  });

  it('records provider success fields only after the leased run commits', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      digestRun: { updateMany },
    } as unknown as PrismaClient;

    await new PrismaDigestDeliveryRepository(prisma).succeed(
      claimedRun,
      'provider-message-1',
      now,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'run-1', userId: 'user-a', status: 'running',
        runLeaseUntil: claimedRun.leaseUntil,
      },
      data: {
        status: 'succeeded', sentAt: now, finishedAt: now,
        providerMessageId: 'provider-message-1', runLeaseUntil: null,
        error: expect.anything(),
      },
    });
  });
});
