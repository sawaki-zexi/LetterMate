import type { DiscoveryCandidate } from '@lettermate/contracts';
import { validateSourceCandidate } from '@lettermate/domain';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import {
  PrismaDiscoveryRepository,
  TopicDiscoveryService,
  type DiscoveryRepository,
} from './discovery-service.js';

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
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    expect(transaction.topic.updateMany).toHaveBeenCalledWith({
      where: { id: 'topic-1', runStatus: { not: 'running' } },
      data: { runStatus: 'running', lastError: expect.anything() },
    });
  });

  it('does not create a second run while the topic is already running', async () => {
    const { prisma, transaction } = createPrisma();
    transaction.topic.updateMany.mockResolvedValue({ count: 0 });

    const runId = await new PrismaDiscoveryRepository(prisma).beginRun(
      'topic-1',
      'manual',
      new Date('2026-07-27T09:00:00.000Z'),
    );

    expect(runId).toBeNull();
    expect(transaction.discoveryRun.create).not.toHaveBeenCalled();
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

  it('reads private adaptive scheduling counters for orchestration', async () => {
    const { prisma } = createPrisma();

    const state = await new PrismaDiscoveryRepository(prisma).getScheduleState('topic-1');

    expect(state).toEqual({
      scheduleIntervalHours: 12,
      productiveRunStreak: 1,
      emptyRunStreak: 0,
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

const sourceCandidate = validateSourceCandidate({
  connectorId: 'twitterapi-io',
  sourceType: 'social',
  platform: 'X',
  externalId: '100',
  url: 'https://x.com/project/status/100',
  title: null,
  content: 'We released version 2 today with a new agent runtime.',
  excerpt: null,
  authorName: 'Project Team',
  authorHandle: 'project',
  publishedAt: '2026-07-27T08:00:00.000Z',
  language: 'en',
  engagement: { likes: 20 },
  proof: {
    kind: 'api_record',
    connectorId: 'twitterapi-io',
    externalId: '100',
  },
});

function createOrchestration() {
  const repository = {
    findOwnedTopic: vi.fn().mockResolvedValue({
      id: 'topic-1',
      userId: 'user-1',
      keyword: 'AI Agent',
      expandedTerms: [],
      createdAt: '2026-07-24T07:00:00.000Z',
      lastRunAt: null,
      nextRunAt: null,
      scheduleIntervalHours: 12,
      runStatus: 'queued',
      lastError: null,
    }),
    beginRun: vi.fn().mockResolvedValue('run-1'),
    listHistoryUrls: vi.fn().mockResolvedValue(['https://example.com/old']),
    getScheduleState: vi.fn().mockResolvedValue({
      scheduleIntervalHours: 12,
      productiveRunStreak: 1,
      emptyRunStreak: 0,
    }),
    saveSuccess: vi.fn().mockResolvedValue({ newItemCount: 1 }),
    saveFailure: vi.fn().mockResolvedValue(undefined),
  };
  const gateway = {
    expandTopic: vi.fn().mockResolvedValue({
      terms: ['intelligent agent'],
      searchQueries: ['AI agent release', '智能体 发布'],
    }),
  };
  const registry = {
    search: vi.fn().mockResolvedValue({
      candidates: [sourceCandidate],
      successfulConnectorIds: ['twitterapi-io'],
      skippedConnectorIds: ['youtube'],
      failures: [{
        connectorId: 'reddit',
        code: 'CONNECTOR_RATE_LIMITED',
        message: 'sensitive upstream detail',
        retryable: true,
      }],
    }),
  };
  const qualityPipeline = {
    run: vi.fn().mockResolvedValue([item]),
  };
  const now = vi.fn()
    .mockReturnValueOnce(new Date('2026-07-27T09:00:00.000Z'))
    .mockReturnValue(new Date('2026-07-27T10:00:00.000Z'));
  const service = new TopicDiscoveryService({
    gateway,
    registry,
    qualityPipeline,
    repository: repository as unknown as DiscoveryRepository,
    now,
    timeoutMs: 600_000,
  });
  return { service, repository, gateway, registry, qualityPipeline };
}

describe('TopicDiscoveryService multi-source orchestration', () => {
  it('routes expanded queries through connectors and the quality pipeline', async () => {
    const { service, repository, gateway, registry, qualityPipeline } = createOrchestration();

    await service.run('topic-1', 'user-1', 'scheduled');

    expect(repository.beginRun).toHaveBeenCalledWith(
      'topic-1',
      'scheduled',
      new Date('2026-07-27T09:00:00.000Z'),
    );
    expect(gateway.expandTopic).toHaveBeenCalledWith({ keyword: 'AI Agent' });
    expect(registry.search).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: 'AI Agent',
        expandedTerms: ['intelligent agent'],
        queries: ['AI agent release', '智能体 发布'],
        sourceTypes: ['web', 'feed', 'social', 'video', 'community', 'code', 'paper'],
        windowStart: '2026-07-20T10:00:00.000Z',
        windowEnd: '2026-07-27T10:00:00.000Z',
      }),
      expect.any(AbortSignal),
    );
    expect(qualityPipeline.run).toHaveBeenCalledWith({
      keyword: 'AI Agent',
      candidates: [sourceCandidate],
      historyUrls: ['https://example.com/old'],
      windowStart: '2026-07-20T10:00:00.000Z',
      windowEnd: '2026-07-27T10:00:00.000Z',
      signal: expect.any(AbortSignal),
    });
    expect(repository.saveSuccess).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      topicId: 'topic-1',
      trigger: 'scheduled',
      expandedTerms: ['intelligent agent', 'AI agent release', '智能体 发布'],
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
      candidateCount: 1,
      acceptedCount: 1,
      schedule: expect.objectContaining({ scheduleIntervalHours: 12 }),
    }));
  });

  it('treats an empty high-precision result as a successful run', async () => {
    const { service, repository, qualityPipeline } = createOrchestration();
    qualityPipeline.run.mockResolvedValue([]);

    await service.run('topic-1', 'user-1', 'scheduled');

    expect(repository.saveSuccess).toHaveBeenCalledWith(expect.objectContaining({
      items: [],
      acceptedCount: 0,
      schedule: expect.objectContaining({
        scheduleIntervalHours: 12,
        emptyRunStreak: 1,
      }),
    }));
    expect(repository.saveFailure).not.toHaveBeenCalled();
  });

  it('keeps successful connector results when another connector fails', async () => {
    const { service, repository } = createOrchestration();

    await service.run('topic-1', 'user-1', 'manual');

    expect(repository.saveSuccess).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'manual',
      items: [item],
    }));
    expect(repository.saveSuccess.mock.calls[0]?.[0]).not.toHaveProperty('schedule');
  });

  it('fails safely when every selected connector fails', async () => {
    const { service, repository, registry } = createOrchestration();
    registry.search.mockResolvedValue({
      candidates: [],
      successfulConnectorIds: [],
      skippedConnectorIds: ['youtube'],
      failures: [{
        connectorId: 'twitterapi-io',
        code: 'CONNECTOR_UPSTREAM_UNAVAILABLE',
        message: 'upstream included a credential',
        retryable: true,
      }],
    });

    await expect(service.run(
      'topic-1',
      'user-1',
      'scheduled',
      { finalAttempt: true },
    )).rejects.toMatchObject({
      code: 'ALL_CONNECTORS_FAILED',
    });

    expect(repository.saveFailure).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      topicId: 'topic-1',
      status: 'failed',
      error: {
        code: 'ALL_CONNECTORS_FAILED',
        message: 'All configured discovery sources failed',
      },
      schedule: expect.objectContaining({
        scheduleIntervalHours: 24,
        nextRunAt: new Date('2026-07-28T10:00:00.000Z'),
      }),
    }));
  });

  it('keeps a retryable failed run queued before the final attempt', async () => {
    const { service, repository, registry } = createOrchestration();
    registry.search.mockRejectedValue(
      new AiGatewayError('AI_RATE_LIMITED', 'Rate limited', true),
    );

    await expect(service.run(
      'topic-1',
      'user-1',
      'scheduled',
      { finalAttempt: false },
    )).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });

    expect(repository.saveFailure).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued',
    }));
    expect(repository.saveFailure.mock.calls[0]?.[0]).not.toHaveProperty('schedule');
  });

  it('does not start a run for a topic owned by another user', async () => {
    const { service, repository, gateway } = createOrchestration();
    repository.findOwnedTopic.mockResolvedValue(null);

    await service.run('topic-1', 'user-2', 'manual');

    expect(repository.beginRun).not.toHaveBeenCalled();
    expect(gateway.expandTopic).not.toHaveBeenCalled();
  });
});
