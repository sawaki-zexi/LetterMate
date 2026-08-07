import type { CreatorJobData, DiscoveryCandidate } from '@lettermate/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  CreatorDiscoveryService,
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
    saveSuccess: vi.fn().mockResolvedValue(1),
    saveFailure: vi.fn().mockResolvedValue(undefined),
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
  it('quality-filters RSS entries without requiring the creator name to match', async () => {
    const repo = repository();
    const qualityPipeline = { run: vi.fn().mockResolvedValue([item]) };
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline,
      createConnector: () => ({
        search: vi.fn().mockResolvedValue({ candidates: [sourceCandidate], requestCount: 1 }),
      }),
      now: () => new Date(now),
    });

    await service.run(job);

    expect(qualityPipeline.run).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'Example Author',
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

  it('persists a retryable queued state before BullMQ retries', async () => {
    const repo = repository();
    const service = new CreatorDiscoveryService({
      repository: repo,
      qualityPipeline: { run: vi.fn() },
      createConnector: () => ({ search: vi.fn().mockRejectedValue(new Error('feed unavailable')) }),
      now: () => new Date(now),
    });

    await expect(service.run(job, { finalAttempt: false })).rejects.toThrow('feed unavailable');
    expect(repo.saveFailure).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      status: 'queued',
      error: { code: 'CREATOR_RUN_FAILED', message: '博主内容同步暂时不可用' },
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
      createConnector,
      now: () => new Date(now),
    });

    await service.run(job);

    expect(createConnector).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'x', accountKey: '44196397', feedUrl: null,
    }));
    expect(search.mock.calls[0]?.[0]).toMatchObject({ sourceTypes: ['social'] });
  });
});
