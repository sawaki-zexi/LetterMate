import type { CreatorJobData, DiscoveryCandidate } from '@lettermate/contracts';
import { validateSourceCandidate } from '@lettermate/domain';
import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import {
  CreatorDiscoveryService,
  PrismaCreatorRepository,
  type CreatorRepository,
} from './creator-service.js';

const job: CreatorJobData = { creatorId: 'creator-1', userId: 'user-1', trigger: 'manual' };
const now = new Date('2026-08-06T08:00:00.000Z');

function repository(): CreatorRepository {
  return {
    claimRun: vi.fn().mockResolvedValue({
      state: 'claimed',
      runId: 'run-1',
      creator: {
        id: 'creator-1',
        userId: 'user-1',
        platform: 'rss',
        accountKey: 'https://example.com/feed.xml',
        displayName: 'Example Author',
        profileUrl: 'https://example.com/',
        feedUrl: 'https://example.com/feed.xml',
      },
    }),
    listHistoryUrls: vi.fn().mockResolvedValue([]),
    listArchiveItemsNeedingLocalization: vi.fn().mockResolvedValue([]),
    saveSuccess: vi.fn().mockResolvedValue(1),
    saveFailure: vi.fn().mockResolvedValue(undefined),
  };
}

function archiveLocalizer() {
  return {
    localizeCreatorItems: vi.fn().mockImplementation(async ({ candidates }) => (
      candidates.map((candidate: { id: string }) => ({
        id: candidate.id,
        title: '中文归档标题',
        summary: '这是一段基于原始内容生成的中文摘要。',
      }))
    )),
  };
}

const sourceCandidate = {
  connectorId: 'rss',
  sourceType: 'feed' as const,
  platform: 'Example Blog',
  externalId: 'entry-1',
  url: 'https://example.com/posts/independent-subject',
  title: 'A subject unrelated to the author name',
  content: 'A substantive article body with enough detail for quality evaluation and source validation.',
  excerpt: null,
  authorName: 'Example Author',
  authorHandle: null,
  publishedAt: '2026-08-06T07:00:00.000Z',
  language: 'en',
  engagement: {},
  proof: {
    kind: 'feed_entry' as const,
    connectorId: 'rss',
    feedUrl: 'https://example.com/feed.xml',
    entryId: 'entry-1',
  },
};

const item: DiscoveryCandidate = {
  kind: 'quality',
  title: '值得阅读的新文章',
  summary: '文章提供了完整的技术分析和可复现细节。',
  reason: '内容深入，并且有公开原文作为依据。',
  sourceUrls: ['https://example.com/posts/independent-subject'],
  publishedAt: '2026-08-06T07:00:00.000Z',
  sourceType: 'feed',
  platform: 'Example Blog',
  authorName: 'Example Author',
  authorHandle: null,
  externalId: 'entry-1',
  provenanceKind: 'feed_entry',
};

describe('creator discovery service', () => {
  it('anchors a resumed run search window to the original run start', async () => {
    const repo = repository();
    vi.mocked(repo.claimRun).mockResolvedValue({
      state: 'claimed',
      runId: 'run-1',
      startedAt: new Date('2026-08-05T08:00:00.000Z'),
      creator: {
        id: 'creator-1', userId: 'user-1', platform: 'rss',
        accountKey: 'https://example.com/feed.xml', displayName: 'Example Author',
        profileUrl: 'https://example.com/', feedUrl: 'https://example.com/feed.xml',
      },
    });
    const search = vi.fn().mockResolvedValue({ candidates: [], requestCount: 1 });
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn().mockResolvedValue([]) },
      archiveLocalizer: archiveLocalizer(),
      createConnector: () => ({ search }),
      now: () => new Date(now),
    });

    await service.run(job);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      windowStart: '2026-07-29T08:00:00.000Z',
      windowEnd: '2026-08-05T08:00:00.000Z',
    }), expect.any(AbortSignal));
  });

  it('quality-filters RSS entries without requiring the creator name to match', async () => {
    const repo = repository();
    const qualityPipeline = { run: vi.fn().mockResolvedValue([item]) };
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline,
      archiveLocalizer: archiveLocalizer(),
      createConnector: () => ({
        search: vi.fn().mockResolvedValue({ candidates: [sourceCandidate], requestCount: 1 }),
      }),
      now: () => new Date(now),
    });

    await service.run(job);

    expect(qualityPipeline.run).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'Example Author',
      execution: { runId: 'run-1', runKind: 'creator', userId: 'user-1' },
      candidates: [expect.objectContaining({ canonicalUrl: sourceCandidate.url })],
    }));
    expect(qualityPipeline.run.mock.calls[0]?.[0]).not.toHaveProperty('matchPolicy');
    expect(repo.saveSuccess).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      creatorId: 'creator-1',
      userId: 'user-1',
      items: [item],
    }));
    expect(repo.saveFailure).not.toHaveBeenCalled();
  });

  it('persists a degraded terminal state when a connector returns usable content with a restricted stream', async () => {
    const repo = repository();
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn().mockResolvedValue([item]) },
      archiveLocalizer: archiveLocalizer(),
      createConnector: () => ({
        search: vi.fn().mockResolvedValue({
          candidates: [sourceCandidate],
          degradations: [{ source: 'dynamic', code: 'CONNECTOR_ACCESS_RESTRICTED', retryable: true }],
        }),
      }),
      now: () => new Date(now),
    });

    await service.run(job);

    expect(repo.saveSuccess).toHaveBeenCalledWith(expect.objectContaining({
      degradations: [{ source: 'dynamic', code: 'CONNECTOR_ACCESS_RESTRICTED', retryable: true }],
    }));
    expect(repo.saveFailure).not.toHaveBeenCalled();
  });

  it('persists a retryable queued state before BullMQ retries', async () => {
    const repo = repository();
    const sourceTelemetry = {
      recordSourceAttempt: vi.fn(),
      recordSourceItems: vi.fn(),
    };
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn() },
      archiveLocalizer: archiveLocalizer(),
      createConnector: () => ({ search: vi.fn().mockRejectedValue(new Error('feed unavailable')) }),
      sourceTelemetry,
      now: () => new Date(now),
    });

    await expect(service.run(job, { finalAttempt: false })).rejects.toThrow('feed unavailable');
    expect(repo.saveFailure).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      status: 'queued',
      error: { code: 'CREATOR_RUN_FAILED', message: '博主内容同步暂时不可用' },
    }));
    expect(sourceTelemetry.recordSourceAttempt).toHaveBeenCalledWith({
      source: 'rss', sourceType: 'feed', result: 'failure', code: 'CREATOR_CONNECTOR_FAILED',
    });
  });

  it('makes an explicit non-retryable failure terminal on the first attempt', async () => {
    const repo = repository();
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn() },
      archiveLocalizer: archiveLocalizer(),
      createConnector: () => ({
        search: vi.fn().mockRejectedValue(
          new AiGatewayError('AI_AUTH_FAILED', 'Authentication failed', false),
        ),
      }),
      now: () => new Date(now),
    });

    await expect(service.run(job, { finalAttempt: false }))
      .rejects.toMatchObject({ code: 'AI_AUTH_FAILED' });
    expect(repo.saveFailure).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
    }));
  });

  it('routes X subscriptions through a social creator connector using the stable account ID', async () => {
    const repo = repository();
    vi.mocked(repo.claimRun).mockResolvedValue({
      state: 'claimed',
      runId: 'run-x',
      creator: {
        id: 'creator-1',
        userId: 'user-1',
        platform: 'x',
        accountKey: '44196397',
        displayName: 'Example Creator',
        profileUrl: 'https://x.com/example',
        feedUrl: null,
      },
    });
    const search = vi.fn().mockResolvedValue({ candidates: [sourceCandidate], requestCount: 1 });
    const createConnector = vi.fn().mockReturnValue({ search });
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn().mockResolvedValue([item]) },
      archiveLocalizer: archiveLocalizer(),
      createConnector,
      now: () => new Date(now),
    });

    await service.run(job);

    expect(createConnector).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'x', accountKey: '44196397', feedUrl: null,
    }));
    expect(search.mock.calls[0]?.[0]).toMatchObject({ sourceTypes: ['social'] });
  });

  it('routes YouTube subscriptions through the video pipeline using the stable channel ID', async () => {
    const repo = repository();
    vi.mocked(repo.claimRun).mockResolvedValue({
      state: 'claimed',
      runId: 'run-youtube',
      creator: {
        id: 'creator-1',
        userId: 'user-1',
        platform: 'youtube',
        accountKey: 'UC1234567890123456789012',
        displayName: 'Example Channel',
        profileUrl: 'https://www.youtube.com/channel/UC1234567890123456789012',
        feedUrl: null,
      },
    });
    const search = vi.fn().mockResolvedValue({ candidates: [sourceCandidate], requestCount: 1 });
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn().mockResolvedValue([item]) },
      archiveLocalizer: archiveLocalizer(),
      createConnector: () => ({ search }),
      now: () => new Date(now),
    });

    await service.run(job);

    expect(search.mock.calls[0]?.[0]).toMatchObject({ sourceTypes: ['video'] });
  });

  it('routes Bluesky subscriptions through the social pipeline using the stable DID', async () => {
    const repo = repository();
    vi.mocked(repo.claimRun).mockResolvedValue({
      state: 'claimed', runId: 'run-bluesky',
      creator: {
        id: 'creator-1', userId: 'user-1', platform: 'bluesky',
        accountKey: 'did:plc:creator', displayName: 'Example Creator',
        profileUrl: 'https://bsky.app/profile/example.bsky.social', feedUrl: null,
      },
    });
    const search = vi.fn().mockResolvedValue({ candidates: [sourceCandidate], requestCount: 1 });
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn().mockResolvedValue([item]) },
      archiveLocalizer: archiveLocalizer(),
      createConnector: () => ({ search }),
      now: () => new Date(now),
    });

    await service.run(job);

    expect(search.mock.calls[0]?.[0]).toMatchObject({ sourceTypes: ['social'] });
  });

  it('localizes a valid archive-only creator item before saving it', async () => {
    const repo = repository();
    const localizer = archiveLocalizer();
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn().mockResolvedValue([]) },
      archiveLocalizer: localizer,
      createConnector: () => ({
        search: vi.fn().mockResolvedValue({ candidates: [sourceCandidate], requestCount: 1 }),
      }),
      now: () => new Date(now),
    });

    await service.run(job);

    expect(localizer.localizeCreatorItems).toHaveBeenCalledWith(expect.objectContaining({
      creatorName: 'Example Author',
      execution: { runId: 'run-1', runKind: 'creator', userId: 'user-1' },
      candidates: [expect.objectContaining({
        id: sourceCandidate.url,
        title: sourceCandidate.title,
        text: sourceCandidate.content,
      })],
    }));
    expect(repo.saveSuccess).toHaveBeenCalledWith(expect.objectContaining({
      items: [],
      archiveLocalizations: [{
        id: sourceCandidate.url,
        title: '中文归档标题',
        summary: '这是一段基于原始内容生成的中文摘要。',
      }],
    }));
    expect(repo.saveFailure).not.toHaveBeenCalled();
  });

  it('splits a failed localization batch and skips only the item that still fails alone', async () => {
    const repo = repository();
    const good = sourceCandidate;
    const bad = {
      ...sourceCandidate,
      externalId: 'entry-2',
      url: 'https://example.com/posts/bad-localization',
      title: 'Another substantive post',
    };
    const localizeCreatorItems = vi.fn().mockImplementation(async ({ candidates }) => {
      if (candidates.length > 1) throw new Error('incomplete batch');
      const [candidate] = candidates;
      if (candidate.id === bad.url) throw new Error('single item failed');
      return [{ id: candidate.id, title: '可用的中文标题', summary: '该内容成功生成了中文摘要。' }];
    });
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn().mockResolvedValue([]) },
      archiveLocalizer: { localizeCreatorItems },
      createConnector: () => ({
        search: vi.fn().mockResolvedValue({ candidates: [good, bad], requestCount: 1 }),
      }),
      now: () => new Date(now),
    });

    await service.run(job);

    expect(localizeCreatorItems.mock.calls.map(([input]) => input.candidates.length)).toEqual([2, 1, 1]);
    expect(repo.saveSuccess).toHaveBeenCalledWith(expect.objectContaining({
      archiveLocalizations: [{
        id: good.url,
        title: '可用的中文标题',
        summary: '该内容成功生成了中文摘要。',
      }],
    }));
    expect(repo.saveFailure).not.toHaveBeenCalled();
  });

  it('requests at most 30 existing archive items for localization backfill', async () => {
    const repo = repository();
    const backfill = Array.from({ length: 30 }, (_, index) => ({
      id: `https://example.com/archive/${index}`,
      title: `English title ${index}`,
      text: `English summary ${index}`,
      platform: 'Example Blog',
      authorName: 'Example Author',
      authorHandle: null,
      publishedAt: null,
    }));
    vi.mocked(repo.listArchiveItemsNeedingLocalization).mockResolvedValue(backfill);
    const localizer = archiveLocalizer();
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn().mockResolvedValue([]) },
      archiveLocalizer: localizer,
      createConnector: () => ({
        search: vi.fn().mockResolvedValue({ candidates: [], requestCount: 1 }),
      }),
      now: () => new Date(now),
    });

    await service.run(job);

    expect(repo.listArchiveItemsNeedingLocalization).toHaveBeenCalledWith('creator-1', 30);
    expect(repo.saveSuccess).toHaveBeenCalledWith(expect.objectContaining({
      archiveLocalizations: expect.arrayContaining([
        expect.objectContaining({ id: 'https://example.com/archive/0' }),
        expect.objectContaining({ id: 'https://example.com/archive/29' }),
      ]),
    }));
  });
});

describe('PrismaCreatorRepository archive localization', () => {
  it('returns no more than the requested number of non-Chinese archive items', async () => {
    const rows = Array.from({ length: 35 }, (_, index) => ({
      id: `item-${index}`,
      canonicalPrimaryUrl: `https://example.com/archive/${index}`,
      title: `English title ${index}`,
      summary: `English summary ${index}`,
      platform: 'Example Blog',
      authorName: 'Example Author',
      authorHandle: null,
      publishedAt: null,
    }));
    const prisma = { creatorItem: { findMany: vi.fn().mockResolvedValue(rows) } };

    const result = await new PrismaCreatorRepository(prisma as never)
      .listArchiveItemsNeedingLocalization('creator-1', 30);

    expect(result).toHaveLength(30);
    expect(result[0]?.id).toBe('https://example.com/archive/0');
    expect(result[29]?.id).toBe('https://example.com/archive/29');
  });

  it('does not overwrite an existing localized item with raw connector fields on a repeated sync', async () => {
    const candidate = validateSourceCandidate(sourceCandidate);
    const transaction = {
      creatorSubscription: {
        findFirst: vi.fn().mockResolvedValue({ id: 'creator-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      creatorItem: {
        findMany: vi.fn().mockResolvedValue([{ canonicalPrimaryUrl: candidate.canonicalUrl }]),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      creatorRun: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };

    await new PrismaCreatorRepository(prisma as never).saveSuccess({
      runId: 'run-1', creatorId: 'creator-1', userId: 'user-1', trigger: 'manual',
      candidates: [candidate], items: [], archiveLocalizations: [], finishedAt: now,
    });

    expect(transaction.creatorItem.upsert).not.toHaveBeenCalled();
    expect(transaction.creatorItem.updateMany).not.toHaveBeenCalled();
  });

  it('keeps feed eligibility separate and preserves original reply context', async () => {
    const archiveSource = validateSourceCandidate({
      ...sourceCandidate,
      externalId: 'reply-1',
      url: 'https://example.com/posts/reply-1',
      creatorContext: {
        contentType: 'reply' as const,
        originalAuthorName: null,
        originalAuthorHandle: null,
        originalContentId: null,
        originalContentUrl: null,
        parentContentId: 'parent-1',
        parentContentUrl: 'https://example.com/posts/parent-1',
        parentContentText: 'The parent post remains original evidence.',
      },
    });
    const acceptedSource = validateSourceCandidate(sourceCandidate);
    const transaction = {
      creatorSubscription: {
        findFirst: vi.fn().mockResolvedValue({ id: 'creator-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      creatorItem: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      creatorRun: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };

    await new PrismaCreatorRepository(prisma as never).saveSuccess({
      runId: 'run-1', creatorId: 'creator-1', userId: 'user-1', trigger: 'manual',
      candidates: [acceptedSource, archiveSource],
      items: [item],
      archiveLocalizations: [{
        id: archiveSource.canonicalUrl,
        title: '归档回复标题',
        summary: '这条回复保留了原始父帖作为证据。',
      }],
      finishedAt: now,
    });

    const creates = transaction.creatorItem.upsert.mock.calls.map(([input]) => input.create);
    expect(creates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalPrimaryUrl: acceptedSource.canonicalUrl,
        feedEligible: true,
        reason: item.reason,
      }),
      expect.objectContaining({
        canonicalPrimaryUrl: archiveSource.canonicalUrl,
        feedEligible: false,
        reason: '未进入本次精选',
        parentContentText: 'The parent post remains original evidence.',
      }),
    ]));
  });

  it('stores degraded status and safe source metadata without provider details', async () => {
    const candidate = validateSourceCandidate(sourceCandidate);
    const transaction = {
      creatorSubscription: {
        findFirst: vi.fn().mockResolvedValue({ id: 'creator-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      creatorItem: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      creatorRun: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };

    await new PrismaCreatorRepository(prisma as never).saveSuccess({
      runId: 'run-1', creatorId: 'creator-1', userId: 'user-1', trigger: 'manual',
      candidates: [candidate], items: [item], archiveLocalizations: [],
      degradations: [{ source: 'dynamic', code: 'CONNECTOR_ACCESS_RESTRICTED', retryable: true }],
      finishedAt: now,
    });

    expect(transaction.creatorRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'degraded',
        degradedSources: [{ source: 'dynamic', code: 'CONNECTOR_ACCESS_RESTRICTED', retryable: true }],
        error: { code: 'CREATOR_PARTIAL_SYNC', message: '部分来源暂时不可用，已保留可用内容' },
      }),
    }));
    expect(transaction.creatorSubscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ runStatus: 'degraded' }),
    }));
  });
});
