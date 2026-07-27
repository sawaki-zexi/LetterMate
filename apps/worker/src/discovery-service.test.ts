import type { DiscoveryCandidate } from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaDiscoveryRepository } from './discovery-service.js';

const finishedAt = new Date('2026-07-27T10:00:00.000Z');

const topicRow = {
  id: 'topic-1',
  userId: 'user-1',
  keyword: 'AI Agent',
  normalizedKeyword: 'ai agent',
  expandedTerms: ['agent'],
  createdAt: new Date('2026-07-24T07:00:00.000Z'),
  lastRunAt: new Date('2026-07-27T07:00:00.000Z'),
  nextRunAt: new Date('2026-07-27T19:00:00.000Z'),
  scheduleIntervalHours: 12,
  productiveRunStreak: 1,
  emptyRunStreak: 0,
  runStatus: 'succeeded' as const,
  lastError: null,
};

const item: DiscoveryCandidate = {
  kind: 'quality',
  title: 'A useful release analysis',
  summary: 'A concise Chinese summary.',
  reason: 'It explains the release with concrete implementation details.',
  sourceUrls: [
    'https://twitter.com/project/status/100?ref_src=twsrc',
    'https://example.com/release?utm_source=x',
  ],
  publishedAt: '2026-07-27T08:00:00.000Z',
  sourceType: 'social',
  platform: 'X',
  authorName: 'Project Team',
  authorHandle: 'project',
  externalId: '100',
  provenanceKind: 'api_record',
};

function createPrisma(existingUrls: string[] = []) {
  const transaction = {
    topic: {
      update: vi.fn().mockResolvedValue(topicRow),
    },
    discoveryRun: {
      create: vi.fn().mockResolvedValue({ id: 'run-1' }),
      update: vi.fn().mockResolvedValue({ id: 'run-1' }),
    },
    discoveryItem: {
      findMany: vi.fn().mockResolvedValue(
        existingUrls.map((canonicalPrimaryUrl) => ({ canonicalPrimaryUrl })),
      ),
      upsert: vi.fn().mockResolvedValue({ id: 'item-1' }),
    },
  };
  const prisma = {
    topic: {
      findFirst: vi.fn().mockResolvedValue(topicRow),
      update: transaction.topic.update,
    },
    discoveryRun: transaction.discoveryRun,
    discoveryItem: transaction.discoveryItem,
    $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => (
      callback(transaction)
    )),
  };
  return { prisma: prisma as unknown as PrismaClient, transaction };
}

describe('PrismaDiscoveryRepository', () => {
  it('maps persisted topic scheduling state', async () => {
    const { prisma } = createPrisma();

    const topic = await new PrismaDiscoveryRepository(prisma).findOwnedTopic(
      'topic-1',
      'user-1',
    );

    expect(topic).toMatchObject({
      nextRunAt: '2026-07-27T19:00:00.000Z',
      scheduleIntervalHours: 12,
    });
  });

  it('creates a durable running record when a run begins', async () => {
    const { prisma, transaction } = createPrisma();
    const repository = new PrismaDiscoveryRepository(prisma);
    const startedAt = new Date('2026-07-27T09:00:00.000Z');

    const runId = await repository.beginRun('topic-1', 'scheduled', startedAt);

    expect(runId).toBe('run-1');
    expect(transaction.discoveryRun.create).toHaveBeenCalledWith({
      data: {
        topicId: 'topic-1',
        trigger: 'scheduled',
        status: 'running',
        startedAt,
      },
      select: { id: true },
    });
    expect(transaction.topic.update).toHaveBeenCalledWith({
      where: { id: 'topic-1' },
      data: { runStatus: 'running', lastError: expect.anything() },
    });
  });

  it('upserts source-aware items and completes a scheduled run', async () => {
    const { prisma, transaction } = createPrisma();
    const repository = new PrismaDiscoveryRepository(prisma);

    const result = await repository.saveSuccess({
      runId: 'run-1',
      topicId: 'topic-1',
      trigger: 'scheduled',
      expandedTerms: ['agent', 'agent'],
      items: [item],
      connectorSummary: {
        successfulConnectorIds: ['twitterapi-io'],
        skippedConnectorIds: ['youtube'],
        failures: [{
          connectorId: 'reddit',
          code: 'CONNECTOR_RATE_LIMITED',
          retryable: true,
        }],
      },
      candidateCount: 4,
      acceptedCount: 1,
      finishedAt,
      schedule: {
        nextRunAt: new Date('2026-07-27T16:00:00.000Z'),
        scheduleIntervalHours: 6,
        productiveRunStreak: 0,
        emptyRunStreak: 0,
      },
    });

    expect(result).toEqual({ newItemCount: 1 });
    expect(transaction.discoveryItem.upsert).toHaveBeenCalledWith({
      where: {
        topicId_canonicalPrimaryUrl: {
          topicId: 'topic-1',
          canonicalPrimaryUrl: 'https://x.com/project/status/100',
        },
      },
      create: expect.objectContaining({
        topicId: 'topic-1',
        sourceType: 'social',
        platform: 'X',
        authorName: 'Project Team',
        authorHandle: 'project',
        externalId: '100',
        provenanceKind: 'api_record',
      }),
      update: expect.objectContaining({
        sourceType: 'social',
        platform: 'X',
        externalId: '100',
        provenanceKind: 'api_record',
      }),
    });
    expect(transaction.discoveryRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: 'succeeded',
        finishedAt,
        connectorSummary: {
          successfulConnectorIds: ['twitterapi-io'],
          skippedConnectorIds: ['youtube'],
          failures: [{
            connectorId: 'reddit',
            code: 'CONNECTOR_RATE_LIMITED',
            retryable: true,
          }],
        },
        candidateCount: 4,
        acceptedCount: 1,
        newItemCount: 1,
        error: expect.anything(),
      }),
    });
    expect(transaction.topic.update).toHaveBeenCalledWith({
      where: { id: 'topic-1' },
      data: expect.objectContaining({
        expandedTerms: ['agent'],
        runStatus: 'succeeded',
        lastRunAt: finishedAt,
        nextRunAt: new Date('2026-07-27T16:00:00.000Z'),
        scheduleIntervalHours: 6,
        productiveRunStreak: 0,
        emptyRunStreak: 0,
      }),
    });
  });

  it('does not change the automatic schedule after a manual run', async () => {
    const { prisma, transaction } = createPrisma([
      'https://x.com/project/status/100',
    ]);
    const repository = new PrismaDiscoveryRepository(prisma);

    const result = await repository.saveSuccess({
      runId: 'run-1',
      topicId: 'topic-1',
      trigger: 'manual',
      expandedTerms: [],
      items: [item],
      connectorSummary: {
        successfulConnectorIds: ['twitterapi-io'],
        skippedConnectorIds: [],
        failures: [],
      },
      candidateCount: 1,
      acceptedCount: 1,
      finishedAt,
    });

    expect(result).toEqual({ newItemCount: 0 });
    const topicUpdate = transaction.topic.update.mock.calls.at(-1)?.[0].data;
    expect(topicUpdate).not.toHaveProperty('nextRunAt');
    expect(topicUpdate).not.toHaveProperty('scheduleIntervalHours');
    expect(topicUpdate).not.toHaveProperty('productiveRunStreak');
    expect(topicUpdate).not.toHaveProperty('emptyRunStreak');
  });

  it('returns canonical URLs for permanent history deduplication', async () => {
    const { prisma, transaction } = createPrisma([
      'https://example.com/old',
      'https://x.com/project/status/99',
    ]);

    const urls = await new PrismaDiscoveryRepository(prisma).listHistoryUrls('topic-1');

    expect(urls).toEqual([
      'https://example.com/old',
      'https://x.com/project/status/99',
    ]);
    expect(transaction.discoveryItem.findMany).toHaveBeenCalledWith({
      where: { topicId: 'topic-1' },
      select: { canonicalPrimaryUrl: true },
    });
  });

  it('records a safe failure without deleting previous items', async () => {
    const { prisma, transaction } = createPrisma();
    const repository = new PrismaDiscoveryRepository(prisma);
    const error = { code: 'AI_AUTH_FAILED', message: 'OpenRouter key is invalid' };

    await repository.saveFailure({
      runId: 'run-1',
      topicId: 'topic-1',
      error,
      finishedAt,
      status: 'failed',
      schedule: {
        nextRunAt: new Date('2026-07-28T10:00:00.000Z'),
        scheduleIntervalHours: 24,
        productiveRunStreak: 0,
        emptyRunStreak: 0,
      },
    });

    expect(transaction.discoveryRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        status: 'failed',
        finishedAt,
        error,
      },
    });
    expect(transaction.topic.update).toHaveBeenCalledWith({
      where: { id: 'topic-1' },
      data: expect.objectContaining({
        runStatus: 'failed',
        lastRunAt: finishedAt,
        lastError: error,
        scheduleIntervalHours: 24,
      }),
    });
    expect(transaction.discoveryItem.upsert).not.toHaveBeenCalled();
  });
});
