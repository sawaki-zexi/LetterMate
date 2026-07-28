import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryCandidate } from '@lettermate/contracts';
import type { ValidatedSourceCandidate } from '@lettermate/domain';
import {
  PrismaTrendRepository,
  TrendDiscoveryService,
  TrendOrchestrationError,
  type TrendRepository,
} from './trend-service.js';

const now = new Date('2026-07-28T12:00:00.000Z');
const seed = (overrides = {}) => ({
  sourceId: 'hacker-news-trends', platform: 'Hacker News', externalId: '42',
  title: 'OpenAI releases gpt-5.7 for software engineering',
  url: 'https://news.ycombinator.com/item?id=42', publishedAt: '2026-07-28T10:00:00.000Z',
  ...overrides,
});
const item: DiscoveryCandidate = {
  kind: 'hot', title: 'GPT-5.7 released', summary: 'A substantive Chinese summary',
  reason: 'Official release', sourceUrls: ['https://openai.com/gpt-5-7'],
  publishedAt: '2026-07-28T09:00:00.000Z', sourceType: 'web', platform: 'OpenAI',
  authorName: null, authorHandle: null, externalId: null, provenanceKind: 'fetched_page',
};
const repository = (overrides: Partial<TrendRepository> = {}): TrendRepository => ({
  claimRun: vi.fn().mockResolvedValue({
    state: 'claimed', runId: 'run-1', monitorId: 'monitor-1', intervalHours: 4,
    nextRunAt: new Date('2026-07-28T16:00:00.000Z'),
  }),
  listRecentFingerprints: vi.fn().mockResolvedValue(new Set()),
  saveSeeds: vi.fn().mockResolvedValue(undefined),
  updateSeedQueries: vi.fn().mockResolvedValue(undefined),
  listHistoryUrls: vi.fn().mockResolvedValue([]),
  completeSuccess: vi.fn().mockResolvedValue({ newItemCount: 1, followUpManual: false }),
  completeFailure: vi.fn().mockResolvedValue({ followUpManual: false }),
  acknowledgeManualFollowUp: vi.fn().mockResolvedValue(true),
  ...overrides,
});
const sourceSummary = (overrides = {}) => ({
  candidates: [seed()], successfulSourceIds: ['hacker-news-trends'], skippedSourceIds: [],
  failures: [], requestCount: 1, requestCounts: { 'hacker-news-trends': 1 }, ...overrides,
});
const makeService = (options: {
  repository?: TrendRepository;
  collect?: ReturnType<typeof vi.fn>;
  classify?: ReturnType<typeof vi.fn>;
  search?: ReturnType<typeof vi.fn>;
  quality?: ReturnType<typeof vi.fn>;
  maxSeeds?: number;
  requestBudget?: number;
} = {}) => {
  const repo = options.repository ?? repository();
  const collect = options.collect ?? vi.fn().mockResolvedValue(sourceSummary());
  const classify = options.classify ?? vi.fn().mockImplementation(async ({ seeds }) =>
    seeds.map(({ id }: { id: string }) => ({
      id, accepted: true, query: 'OpenAI gpt-5.7 software engineering',
      requiredTerms: ['OpenAI', 'gpt-5.7'],
    })));
  const search = options.search ?? vi.fn().mockResolvedValue({
    candidates: [] as ValidatedSourceCandidate[], successfulConnectorIds: ['openrouter-search'],
    skippedConnectorIds: [], failures: [],
  });
  const quality = options.quality ?? vi.fn().mockResolvedValue([item]);
  return {
    repo, collect, classify, search, quality,
    service: new TrendDiscoveryService({
      repository: repo,
      trendSources: { collect },
      gateway: { classifyTrendSeeds: classify },
      connectors: { search },
      qualityPipeline: { run: quality },
      now: () => now,
      timeoutMs: 30_000,
      maxSeeds: options.maxSeeds ?? 60,
      trendRequestBudget: options.requestBudget ?? 24,
    }),
  };
};

describe('TrendDiscoveryService', () => {
  it('treats one successful trend source with no candidates as a successful zero-item run', async () => {
    const repo = repository({
      completeSuccess: vi.fn().mockResolvedValue({ newItemCount: 0, followUpManual: false }),
    });
    const { service, classify, search, quality } = makeService({
      repository: repo,
      collect: vi.fn().mockResolvedValue(sourceSummary({ candidates: [] })),
    });

    await expect(service.run('user-1', 'scheduled')).resolves.toEqual({ followUpManual: false });

    expect(classify).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(quality).not.toHaveBeenCalled();
    expect(repo.completeSuccess).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', userId: 'user-1', candidateCount: 0, acceptedCount: 0, items: [],
    }));
  });

  it('fails safely when all trend sources fail and saves no radar items', async () => {
    const repo = repository();
    const { service } = makeService({
      repository: repo,
      collect: vi.fn().mockResolvedValue(sourceSummary({
        candidates: [], successfulSourceIds: [],
        failures: [{ sourceId: 'one', code: 'PRIVATE', message: 'do not persist', retryable: true }],
      })),
    });

    await expect(service.run('user-1', 'scheduled')).rejects.toMatchObject({
      code: 'ALL_TREND_SOURCES_FAILED', retryable: true,
    });
    expect(repo.completeSuccess).not.toHaveBeenCalled();
    expect(repo.completeFailure).toHaveBeenCalledWith(expect.objectContaining({
      error: { code: 'ALL_TREND_SOURCES_FAILED', message: 'All configured trend sources failed' },
    }));
    expect(JSON.stringify(vi.mocked(repo.completeFailure).mock.calls)).not.toContain('do not persist');
  });

  it('deduplicates recent seeds, classifies in bounded batches, and persists sanitized decisions', async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => seed({
      externalId: String(index), title: `Project-${index} version-${index}.1 software release`,
      url: `https://example.com/trend/${index}`,
    }));
    const classify = vi.fn(async ({ seeds }: { seeds: Array<{ id: string; title: string }> }) =>
      seeds.map(({ id, title }) => ({
        id, accepted: true, query: title, requiredTerms: [title.match(/version-\d+\.1/u)![0]],
      })));
    const repo = repository({
      listRecentFingerprints: vi.fn().mockImplementation(async (_userId, fingerprints) =>
        new Set([fingerprints[0]])),
      completeSuccess: vi.fn().mockResolvedValue({ newItemCount: 0, followUpManual: false }),
    });
    const { service } = makeService({
      repository: repo, classify, maxSeeds: 40,
      collect: vi.fn().mockResolvedValue(sourceSummary({ candidates })),
      quality: vi.fn().mockResolvedValue([]),
    });

    await service.run('user-1', 'scheduled');

    expect(classify).toHaveBeenCalledTimes(3);
    expect(classify.mock.calls.map(([input]) => input.seeds.length)).toEqual([3, 3, 1]);
    const saved = vi.mocked(repo.saveSeeds).mock.calls[0]![0];
    expect(saved.seeds).toHaveLength(7);
    expect(saved.seeds[0]).toEqual(expect.objectContaining({
      sourceId: 'hacker-news-trends', normalizedQuery: null,
    }));
    expect(saved.seeds[0]).not.toHaveProperty('rank');
    expect(saved.seeds[0]).not.toHaveProperty('payload');
    expect(repo.updateSeedQueries).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      userId: 'user-1',
      decisions: expect.arrayContaining([
        expect.objectContaining({ normalizedQuery: expect.stringContaining('version-1.1') }),
      ]),
    }));
  });

  it('persists rejected technical-filter decisions with a null query', async () => {
    const repo = repository({
      completeSuccess: vi.fn().mockResolvedValue({ newItemCount: 0, followUpManual: false }),
    });
    const classify = vi.fn().mockImplementation(async ({ seeds }) => seeds.map(({ id }: { id: string }) => ({
      id, accepted: false, query: null, requiredTerms: [],
    })));
    const { service, search } = makeService({ repository: repo, classify });

    await service.run('user-1', 'scheduled');

    expect(search).not.toHaveBeenCalled();
    expect(repo.saveSeeds).toHaveBeenCalledWith(expect.objectContaining({
      seeds: [expect.objectContaining({ normalizedQuery: null })],
    }));
  });

  it('persists sanitized seeds before AI classification and keeps them after invalid output', async () => {
    const repo = repository();
    const { service } = makeService({
      repository: repo,
      classify: vi.fn().mockResolvedValue([{
        id: 'unknown', accepted: true, query: 'generic software', requiredTerms: [],
      }]),
    });

    await expect(service.run('user-1', 'scheduled')).rejects.toBeInstanceOf(TrendOrchestrationError);
    expect(repo.saveSeeds).toHaveBeenCalledWith({
      runId: 'run-1',
      userId: 'user-1',
      seeds: [expect.objectContaining({
        sourceId: 'hacker-news-trends',
        platform: 'Hacker News',
        externalId: '42',
        sourceUrl: 'https://news.ycombinator.com/item?id=42',
        fingerprint: expect.any(String),
        normalizedQuery: null,
      })],
    });
    expect(repo.updateSeedQueries).not.toHaveBeenCalled();
    expect(repo.completeSuccess).not.toHaveBeenCalled();
    expect(repo.completeFailure).toHaveBeenCalledOnce();
  });

  it('builds version-preserving connector plans and passes their required match policy to quality', async () => {
    const { service, search, quality } = makeService();

    await service.run('user-1', 'scheduled');

    const plan = search.mock.calls[0]![0];
    expect(plan.keyword).toContain('gpt-5.7');
    expect(plan.queries.join(' ')).toContain('gpt-5.7');
    expect(plan.expandedTerms).toContain('gpt-5.7');
    expect(quality).toHaveBeenCalledWith(expect.objectContaining({
      keyword: expect.stringContaining('gpt-5.7'), matchPolicy: plan.matchPolicy,
    }));
  });

  it('honors trend budgets and forwards one AbortSignal through sources, connectors, and quality', async () => {
    const { service, collect, search, quality } = makeService({ maxSeeds: 7, requestBudget: 9 });

    await service.run('user-1', 'scheduled');

    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ maxCandidates: 7, requestBudget: 9 }), expect.any(AbortSignal));
    const signal = collect.mock.calls[0]![1];
    expect(search.mock.calls[0]![1]).toBe(signal);
    expect(quality.mock.calls[0]![0].signal).toBe(signal);
  });

  it('returns exactly one registered manual follow-up signal after atomic completion', async () => {
    const repo = repository({
      completeSuccess: vi.fn().mockResolvedValue({ newItemCount: 1, followUpManual: true }),
    });
    const { service } = makeService({ repository: repo });

    await expect(service.run('user-1', 'scheduled')).resolves.toEqual({ followUpManual: true });
    expect(repo.completeSuccess).toHaveBeenCalledOnce();
  });
});

describe('PrismaTrendRepository', () => {
  it('provisions a missing monitor with the configured default interval for manual discovery', async () => {
    const provisioned = {
      id: 'monitor-new', userId: 'user-1', runStatus: 'queued', activeRunId: null,
      runLeaseUntil: null, intervalHours: 8,
      nextRunAt: now, manualRefreshPending: false,
    };
    const transaction = {
      trendMonitor: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(provisioned),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      trendRun: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };
    const repo = new PrismaTrendRepository(prisma as never, 10 * 60_000, 8);

    await expect(repo.claimRun('user-1', 'manual', now)).resolves.toMatchObject({
      state: 'claimed', monitorId: 'monitor-new', intervalHours: 8,
    });

    expect(transaction.trendMonitor.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: {
        userId: 'user-1', intervalHours: 8, nextRunAt: now, runStatus: 'queued',
      },
      update: {},
    });
  });

  it('registers exactly one pending manual refresh while an active lease exists', async () => {
    const transaction = {
      trendMonitor: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({
            id: 'monitor-1', userId: 'user-1', runStatus: 'running', activeRunId: 'run-1',
            runLeaseUntil: new Date('2026-07-28T12:05:00.000Z'), intervalHours: 4,
            nextRunAt: new Date('2026-07-28T16:00:00.000Z'), manualRefreshPending: false,
          })
          .mockResolvedValueOnce({
            id: 'monitor-1', userId: 'user-1', runStatus: 'running', activeRunId: 'run-1',
            runLeaseUntil: new Date('2026-07-28T12:05:00.000Z'), intervalHours: 4,
            nextRunAt: new Date('2026-07-28T16:00:00.000Z'), manualRefreshPending: true,
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };
    const repo = new PrismaTrendRepository(prisma as never, 10 * 60_000);

    await expect(repo.claimRun('user-1', 'manual', now)).resolves.toEqual({
      state: 'active', followUpManualRegistered: true,
    });
    await expect(repo.claimRun('user-1', 'manual', now)).resolves.toEqual({
      state: 'active', followUpManualRegistered: false,
    });
    expect(transaction.trendMonitor.updateMany).toHaveBeenCalledTimes(1);
  });

  it('resumes the same queued manual run without clearing a pending follow-up', async () => {
    const transaction = {
      trendMonitor: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'monitor-1', userId: 'user-1', runStatus: 'queued', activeRunId: 'run-1',
          runLeaseUntil: new Date('2026-07-28T12:05:00.000Z'), intervalHours: 4,
          nextRunAt: new Date('2026-07-28T16:00:00.000Z'), manualRefreshPending: true,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      trendRun: {
        findUnique: vi.fn().mockResolvedValue({ trigger: 'manual', status: 'queued' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };
    const repo = new PrismaTrendRepository(prisma as never, 10 * 60_000);

    await expect(repo.claimRun('user-1', 'manual', now)).resolves.toMatchObject({
      state: 'claimed', runId: 'run-1', monitorId: 'monitor-1',
    });

    expect(transaction.trendMonitor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ manualRefreshPending: false }),
    }));
  });

  it('does not complete failure after its run lease has been lost', async () => {
    const transaction = {
      trendMonitor: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      trendRun: { update: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };
    const repo = new PrismaTrendRepository(prisma as never, 10 * 60_000);

    await expect(repo.completeFailure({
      runId: 'run-1', monitorId: 'monitor-1', userId: 'user-1', trigger: 'scheduled',
      error: { code: 'FAILED', message: 'Safe failure' }, finishedAt: now, status: 'failed',
    })).resolves.toEqual({ followUpManual: false });

    expect(transaction.trendMonitor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ runLeaseUntil: { gt: now } }),
    }));
    expect(transaction.trendRun.update).not.toHaveBeenCalled();
    expect(transaction.trendMonitor.update).not.toHaveBeenCalled();
  });

  it('uses createMany skipDuplicates count as the actual new radar item count in one transaction', async () => {
    const transaction = {
      trendMonitor: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ manualRefreshPending: true, intervalHours: 4, nextRunAt: new Date('2026-07-28T16:00:00.000Z') }),
        update: vi.fn().mockResolvedValue({}),
      },
      radarItem: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      trendRun: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };
    const repo = new PrismaTrendRepository(prisma as never, 10 * 60_000);

    const result = await repo.completeSuccess({
      runId: 'run-1', monitorId: 'monitor-1', userId: 'user-1', trigger: 'scheduled',
      candidateCount: 2, acceptedCount: 2, items: [item, { ...item }], finishedAt: now,
    });

    expect(transaction.radarItem.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(transaction.radarItem.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          userId: 'user-1', runId: 'run-1',
          canonicalPrimaryUrl: 'https://openai.com/gpt-5-7',
        }),
      ]),
      skipDuplicates: true,
    });
    expect(transaction.trendRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ newItemCount: 1, status: 'succeeded', finishedAt: now }),
    }));
    expect(result).toEqual({ newItemCount: 1, followUpManual: true });
  });

  it('retries a final scheduled failure at the monitor configured interval', async () => {
    const transaction = {
      trendMonitor: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ manualRefreshPending: false, intervalHours: 8 }),
        update: vi.fn().mockResolvedValue({}),
      },
      trendRun: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };
    const repo = new PrismaTrendRepository(prisma as never, 10 * 60_000);

    await repo.completeFailure({
      runId: 'run-1', monitorId: 'monitor-1', userId: 'user-1', trigger: 'scheduled',
      error: { code: 'FAILED', message: 'Safe failure' }, finishedAt: now, status: 'failed',
    });

    expect(transaction.trendMonitor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        runStatus: 'failed',
        nextRunAt: new Date('2026-07-28T20:00:00.000Z'),
      }),
    }));
  });

  it('keeps the active lease and pending manual flag across a non-final failure', async () => {
    const transaction = {
      trendMonitor: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ manualRefreshPending: true, intervalHours: 4 }),
        update: vi.fn().mockResolvedValue({}),
      },
      trendRun: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };
    const repo = new PrismaTrendRepository(prisma as never, 10 * 60_000);

    await expect(repo.completeFailure({
      runId: 'run-1', monitorId: 'monitor-1', userId: 'user-1', trigger: 'scheduled',
      error: { code: 'FAILED', message: 'Safe failure' }, finishedAt: now, status: 'queued',
    })).resolves.toEqual({ followUpManual: false });

    expect(transaction.trendMonitor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        runStatus: 'queued', activeRunId: 'run-1',
        manualRefreshPending: true,
      }),
    }));
    expect(transaction.trendMonitor.update.mock.calls[0]![0].data)
      .not.toHaveProperty('runLeaseUntil');
  });

  it('scopes seed query updates and manual acknowledgements to their owner and run state', async () => {
    const prisma = {
      trendSeed: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      trendMonitor: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const repo = new PrismaTrendRepository(prisma as never, 10 * 60_000);

    await repo.updateSeedQueries({
      runId: 'run-1', userId: 'user-1',
      decisions: [{ fingerprint: 'fingerprint-1', normalizedQuery: 'OpenAI gpt-5.7' }],
    });
    await expect(repo.acknowledgeManualFollowUp('user-1')).resolves.toBe(true);

    expect(prisma.trendSeed.updateMany).toHaveBeenCalledWith({
      where: { runId: 'run-1', userId: 'user-1', fingerprint: 'fingerprint-1' },
      data: { normalizedQuery: 'OpenAI gpt-5.7' },
    });
    expect(prisma.trendMonitor.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1', runStatus: 'queued', activeRunId: null,
        manualRefreshPending: true,
      },
      data: { manualRefreshPending: false },
    });
  });

  it('relies on the database run fingerprint key for race-safe idempotent seed inserts', async () => {
    const prisma = {
      trendSeed: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const repo = new PrismaTrendRepository(prisma as never, 10 * 60_000);

    await repo.saveSeeds({
      runId: 'run-1',
      userId: 'user-1',
      seeds: [{
        fingerprint: 'fingerprint-1', sourceId: 'hacker-news-trends',
        platform: 'Hacker News', externalId: '42', title: 'React 19.1 release',
        sourceUrl: 'https://example.com/react', publishedAt: now, normalizedQuery: null,
      }],
    });

    expect(prisma.trendSeed.findMany).not.toHaveBeenCalled();
    expect(prisma.trendSeed.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: [expect.objectContaining({
        runId: 'run-1', userId: 'user-1', fingerprint: 'fingerprint-1',
      })],
    }));
  });
});
