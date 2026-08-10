import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { DigestBriefGenerator } from './digest-brief-generator.js';
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
    citationUrls: ['https://example.com/1'], platform: 'Example', publishedAt: null,
    evidence: '理由', uncertainty: '仍需核验原文。', followUp: '继续关注后续更新。',
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
        id: expect.any(String),
        userId: 'user-a',
        scheduledLocalDate: '2026-08-08',
        windowStart: boundary,
        windowEnd: now,
        status: 'skipped',
        finishedAt: now,
        briefGenerationStatus: 'fallback',
        briefGenerationVersion: 'digest-brief-fallback-v1',
        briefGenerationErrorCode: null,
      },
      select: { id: true },
    });
    expect(transaction.contentInterestTag.findMany).not.toHaveBeenCalled();
  });

  it('builds one frozen cross-source snapshot and excludes an adjacent exploration trend', async () => {
    const source = (id: string, url: string) => ({
      id, kind: 'quality' as const, title: `标题 ${id}`, summary: `摘要 ${id}`, reason: `理由 ${id}`,
      sourceUrls: [url], canonicalPrimaryUrl: url, publishedAt: now,
      discoveredAt: now, sourceType: 'web' as const, platform: 'Example',
      authorName: null, authorHandle: null, externalId: id, provenanceKind: 'fetched_page' as const,
    });
    const followed = {
      ...source('topic', 'https://example.com/followed'),
      topicId: 'topic-1', topicKeyword: 'AI Agent', topic: { deletedAt: null, keyword: 'AI Agent' },
    };
    const adjacent = source('adjacent', 'https://example.com/adjacent');
    const creator = {
      ...source('creator', 'https://example.com/creator'),
      creatorId: 'creator-1', contentType: 'original' as const,
      creator: { displayName: 'Followed Creator' },
    };
    const create = vi.fn().mockResolvedValue({ id: 'run-ranked' });
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      digestRun: {
        findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null), create,
      },
      discoveryItem: { findMany: vi.fn().mockResolvedValue([followed]) },
      radarItem: { findMany: vi.fn().mockResolvedValue([
        { ...source('trend-duplicate', followed.canonicalPrimaryUrl), canonicalPrimaryUrl: followed.canonicalPrimaryUrl },
        adjacent,
      ]) },
      creatorItem: { findMany: vi.fn().mockResolvedValue([creator]) },
      digestItem: { findMany: vi.fn().mockResolvedValue([]) },
      interestMemorySettings: { findUnique: vi.fn().mockResolvedValue({ personalizationEnabled: true }) },
      userInterestProfile: { findMany: vi.fn().mockResolvedValue([{
        tagId: 'tag-core', shortScore: 5, longScore: 3, negativeScore: 0,
        evidenceUpdatedAt: now, sourceKinds: ['interested'],
      }]) },
      forgottenInterestTag: { findMany: vi.fn().mockResolvedValue([]) },
      contentInterestTag: { findMany: vi.fn().mockResolvedValue([
        { contentKey: adjacent.canonicalPrimaryUrl, tagId: 'tag-edge', confidence: 0.95 },
        { contentKey: creator.canonicalPrimaryUrl, tagId: 'tag-core', confidence: 0.95 },
      ]) },
      interestTagAdjacency: { findMany: vi.fn().mockResolvedValue([
        { leftTagId: 'tag-core', rightTagId: 'tag-edge' },
      ]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as PrismaClient;
    const briefGenerator = {
      generate: vi.fn(async ({ snapshots }: Parameters<DigestBriefGenerator['generate']>[0]) => ({
        items: snapshots.map((snapshot) => ({
          ...snapshot,
          summary: `AI 结论：${snapshot.summary}`,
          evidence: `AI 证据：${snapshot.reason}`,
          uncertainty: 'AI 标记的材料限制。',
          followUp: 'AI 建议的后续关注点。',
        })),
        status: 'generated' as const,
        version: 'digest-brief-grounded-v1',
        errorCode: null,
      })),
    };

    await expect(new PrismaDigestScheduleRepository(prisma, briefGenerator).ensureRun({
      userId: 'user-a', scheduledLocalDate: '2026-08-08', windowEnd: now, now,
    })).resolves.toEqual({ runId: 'run-ranked', userId: 'user-a', status: 'queued' });

    const frozen = create.mock.calls[0]?.[0].data.items.create;
    expect(frozen).toHaveLength(2);
    expect(frozen.every((item: { summary: string }) => item.summary.startsWith('AI 结论：'))).toBe(true);
    expect(frozen.map((item: { contentKey: string }) => item.contentKey)).toEqual(expect.arrayContaining([
      followed.canonicalPrimaryUrl, creator.canonicalPrimaryUrl,
    ]));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        briefGenerationStatus: 'generated',
        briefGenerationVersion: 'digest-brief-grounded-v1',
        briefGenerationErrorCode: null,
      }),
    }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(briefGenerator.generate).toHaveBeenCalledTimes(1);
    expect(briefGenerator.generate.mock.calls[0]?.[0].runId)
      .toBe(create.mock.calls[0]?.[0].data.id);
    expect(transaction.interestTagAdjacency.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ relationVersion: 'qualified-content-cooccurrence-v1' }),
    }));
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
