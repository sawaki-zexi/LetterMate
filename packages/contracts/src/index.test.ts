import { describe, expect, it } from 'vitest';
import {
  discoveryItemSchema,
  discoveryJobDataSchema,
  discoveryQueueName,
  discoveryResultSchema,
  discoverySourceStatusSchema,
  feedItemSchema,
  feedOriginSchema,
  feedQuerySchema,
  feedRangeSchema,
  runSummarySchema,
  sourceTypeSchema,
  topicFeedItemSchema,
  topicSchema,
  topicInputSchema,
  trendFeedItemSchema,
  trendJobDataSchema,
  trendQueueName,
  trendStatusSchema,
} from './index.js';

const feedItemFixture = {
  id: 'item-1',
  kind: 'hot' as const,
  title: 'Project update',
  summary: 'Chinese summary',
  reason: 'Recent primary-source announcement',
  sourceUrls: ['https://example.com/project'],
  publishedAt: '2026-07-27T08:00:00.000Z',
  discoveredAt: '2026-07-27T08:05:00.000Z',
  sourceType: 'web' as const,
  platform: 'Example',
  authorName: null,
  authorHandle: null,
  externalId: '123',
  provenanceKind: 'fetched_page' as const,
};

describe('AI discovery contracts', () => {
  it('shares one stable discovery queue name', () => {
    expect(discoveryQueueName).toBe('topic-discovery');
  });

  it('accepts exactly one trimmed keyword', () => {
    expect(topicInputSchema.parse({ keyword: '  AI Agent  ' })).toEqual({ keyword: 'AI Agent' });
    expect(() => topicInputSchema.parse({ keyword: '' })).toThrow();
    expect(() => topicInputSchema.parse({ keyword: 'x'.repeat(101) })).toThrow();
  });

  it('requires hot or quality items with summary, reason and source URLs', () => {
    const result = discoveryResultSchema.parse({
      citations: ['https://example.com/release'],
      items: [
        {
          kind: 'quality',
          title: 'Agent release',
          summary: '这是中文摘要。',
          reason: '内容提供了完整实现细节。',
          sourceUrls: ['https://example.com/release'],
          publishedAt: '2026-07-24T06:30:00.000Z',
          sourceType: 'web',
          platform: 'Example',
          authorName: null,
          authorHandle: null,
          externalId: null,
          provenanceKind: 'ai_citation',
        },
      ],
    });

    expect(result.items[0]?.kind).toBe('quality');
  });

  it('rejects obsolete trust classifications', () => {
    expect(() =>
      discoveryResultSchema.parse({
        citations: ['https://example.com/release'],
        items: [
          {
            kind: 'confirmed',
            title: 'Agent release',
            summary: '这是中文摘要。',
            reason: '错误的旧状态。',
            sourceUrls: ['https://example.com/release'],
            publishedAt: null,
            sourceType: 'web',
            platform: 'Example',
            authorName: null,
            authorHandle: null,
            externalId: null,
            provenanceKind: 'ai_citation',
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts source categories and exact feed filters', () => {
    expect(sourceTypeSchema.options).toEqual([
      'web',
      'feed',
      'social',
      'video',
      'community',
      'code',
      'paper',
    ]);
    expect(feedRangeSchema.options).toEqual(['1d', '3d', '7d', '30d', '90d', 'all']);
    expect(feedOriginSchema.options).toEqual(['all', 'topic', 'trend']);
    expect(() => feedRangeSchema.parse('archive')).toThrow();
    expect(() => feedOriginSchema.parse('keyword')).toThrow();
  });

  it('normalizes persisted Feed search queries with existing filters', () => {
    expect(feedQuerySchema.parse({
      q: '  智能体工程  ', range: '30d', origin: 'topic', kind: 'quality',
    })).toEqual({
      q: '智能体工程', range: '30d', origin: 'topic', kind: 'quality',
    });
    expect(feedQuerySchema.parse({ q: '   ' })).toEqual({
      q: undefined, range: '30d', origin: 'all',
    });
    expect(() => feedQuerySchema.parse({ q: 'x'.repeat(101) })).toThrow();
    expect(() => feedQuerySchema.parse({
      topicId: 'topic-1', origin: 'trend',
    })).toThrow();
  });

  it('accepts authoritative run summaries for every status', () => {
    const baseRun = {
      id: 'run-1',
      trigger: 'manual',
      startedAt: '2026-07-28T00:00:00.000Z',
    } as const;
    const runs = [
      { ...baseRun, status: 'queued' as const, finishedAt: null, newItemCount: null },
      { ...baseRun, status: 'running' as const, finishedAt: null, newItemCount: null },
      {
        ...baseRun,
        status: 'succeeded' as const,
        finishedAt: '2026-07-28T00:01:00.000Z',
        newItemCount: 3,
      },
      {
        ...baseRun,
        status: 'failed' as const,
        finishedAt: '2026-07-28T00:01:00.000Z',
        newItemCount: null,
      },
    ];

    expect(runs.map((run) => runSummarySchema.parse(run).status)).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
    ]);
  });

  it.each([
    ['queued with a finish time', { status: 'queued', finishedAt: '2026-07-28T00:01:00.000Z', newItemCount: null }],
    ['queued with a count', { status: 'queued', finishedAt: null, newItemCount: 0 }],
    ['running with a finish time', { status: 'running', finishedAt: '2026-07-28T00:01:00.000Z', newItemCount: null }],
    ['running with a count', { status: 'running', finishedAt: null, newItemCount: 0 }],
    ['succeeded without a finish time', { status: 'succeeded', finishedAt: null, newItemCount: 1 }],
    ['succeeded without a count', { status: 'succeeded', finishedAt: '2026-07-28T00:01:00.000Z', newItemCount: null }],
    ['succeeded with a negative count', { status: 'succeeded', finishedAt: '2026-07-28T00:01:00.000Z', newItemCount: -1 }],
    ['succeeded with a fractional count', { status: 'succeeded', finishedAt: '2026-07-28T00:01:00.000Z', newItemCount: 1.5 }],
    ['failed without a finish time', { status: 'failed', finishedAt: null, newItemCount: null }],
    ['failed with a count', { status: 'failed', finishedAt: '2026-07-28T00:01:00.000Z', newItemCount: 1 }],
  ])('rejects impossible run state: %s', (_label, state) => {
    expect(() => runSummarySchema.parse({
      id: 'run-1',
      trigger: 'manual',
      startedAt: '2026-07-28T00:00:00.000Z',
      ...state,
    })).toThrow();
  });

  it('accepts scheduled topics with a constrained interval', () => {
    const topic = topicSchema.parse({
      id: 'topic-1',
      userId: 'user-1',
      keyword: 'AI agents',
      expandedTerms: ['agent framework'],
      createdAt: '2026-07-27T00:00:00.000Z',
      lastRunAt: null,
      nextRunAt: '2026-07-28T00:00:00.000Z',
      scheduleIntervalHours: 12,
      runStatus: 'succeeded',
      lastError: null,
      lastRun: null,
    });

    expect(topic).toMatchObject({
      nextRunAt: '2026-07-28T00:00:00.000Z',
      scheduleIntervalHours: 12,
    });
    expect(() => topicSchema.parse({ ...topic, scheduleIntervalHours: 8 })).toThrow();
    const { lastRun: _lastRun, ...topicWithoutLastRun } = topic;
    expect(() => topicSchema.parse(topicWithoutLastRun)).toThrow();
  });

  it('accepts social discovery items with provenance and author metadata', () => {
    const item = discoveryItemSchema.parse({
      id: 'item-1',
      topicId: 'topic-1',
      kind: 'hot',
      title: 'Project update',
      summary: 'Chinese summary',
      reason: 'Recent primary-source announcement',
      sourceUrls: ['https://x.com/project/status/123'],
      publishedAt: '2026-07-27T08:00:00.000Z',
      discoveredAt: '2026-07-27T08:05:00.000Z',
      sourceType: 'social',
      platform: 'X',
      authorName: 'Project Team',
      authorHandle: 'project',
      externalId: '123',
      provenanceKind: 'api_record',
    });

    expect(item).toMatchObject({
      sourceType: 'social',
      platform: 'X',
      authorName: 'Project Team',
      authorHandle: 'project',
      externalId: '123',
      provenanceKind: 'api_record',
    });
  });

  it('accepts trigger-aware discovery jobs', () => {
    expect(
      discoveryJobDataSchema.parse({
        topicId: 'topic-1',
        userId: 'user-1',
        trigger: 'scheduled',
      }),
    ).toMatchObject({ trigger: 'scheduled' });
  });

  it('requires durable registration identities for trend jobs', () => {
    expect(trendQueueName).toBe('trend-discovery');
    expect(trendJobDataSchema.parse({
      userId: 'user-a', trigger: 'manual', runId: 'manual-run-1',
    })).toEqual({
      userId: 'user-a',
      trigger: 'manual',
      runId: 'manual-run-1',
    });
    expect(trendJobDataSchema.parse({
      userId: 'user-a', trigger: 'scheduled', dueAt: '2026-07-29T08:00:00.000Z',
    })).toEqual({
      userId: 'user-a',
      trigger: 'scheduled',
      dueAt: '2026-07-29T08:00:00.000Z',
    });
    expect(() => trendJobDataSchema.parse({ userId: 'user-a', trigger: 'manual' })).toThrow();
    expect(() => trendJobDataSchema.parse({ userId: 'user-a', trigger: 'scheduled' })).toThrow();
    expect(() => trendJobDataSchema.parse({
      userId: 'user-a', trigger: 'scheduled', dueAt: 'not-a-date',
    })).toThrow();
  });

  it('discriminates topic and trend feed items by origin', () => {
    const topicItem = { ...feedItemFixture, origin: 'topic' as const, topicId: 'topic-1' };
    const trendItem = { ...feedItemFixture, origin: 'trend' as const, topicId: null };

    expect(topicFeedItemSchema.parse(topicItem).origin).toBe('topic');
    expect(trendFeedItemSchema.parse(trendItem).origin).toBe('trend');
    expect(feedItemSchema.parse(topicItem).topicId).toBe('topic-1');
    expect(feedItemSchema.parse(trendItem).topicId).toBeNull();
    expect(() => feedItemSchema.parse({ ...topicItem, topicId: null })).toThrow();
    expect(() => feedItemSchema.parse({ ...trendItem, topicId: 'topic-1' })).toThrow();
  });

  it('accepts only HTTP(S) citations and feed source URLs', () => {
    const httpUrls = ['http://example.com/source', 'https://example.com/source'];

    expect(discoveryResultSchema.parse({ citations: httpUrls, items: [] }).citations).toEqual(
      httpUrls,
    );
    for (const sourceUrl of httpUrls) {
      const topicItem = {
        ...feedItemFixture,
        sourceUrls: [sourceUrl],
        origin: 'topic' as const,
        topicId: 'topic-1',
      };
      const trendItem = {
        ...feedItemFixture,
        sourceUrls: [sourceUrl],
        origin: 'trend' as const,
        topicId: null,
      };

      expect(topicFeedItemSchema.parse(topicItem).sourceUrls).toEqual([sourceUrl]);
      expect(trendFeedItemSchema.parse(trendItem).sourceUrls).toEqual([sourceUrl]);
      expect(feedItemSchema.parse(topicItem).sourceUrls).toEqual([sourceUrl]);
      expect(feedItemSchema.parse(trendItem).sourceUrls).toEqual([sourceUrl]);
    }
  });

  it.each([
    'javascript:alert(1)',
    'data:text/plain,unsafe',
    'file:///tmp/unsafe',
    'ftp://example.com/unsafe',
  ])('rejects non-HTTP(S) citations and feed source URLs: %s', (sourceUrl) => {
    const topicItem = {
      ...feedItemFixture,
      sourceUrls: [sourceUrl],
      origin: 'topic' as const,
      topicId: 'topic-1',
    };
    const trendItem = {
      ...feedItemFixture,
      sourceUrls: [sourceUrl],
      origin: 'trend' as const,
      topicId: null,
    };

    expect(() => discoveryResultSchema.parse({ citations: [sourceUrl], items: [] })).toThrow();
    expect(() => topicFeedItemSchema.parse(topicItem)).toThrow();
    expect(() => trendFeedItemSchema.parse(trendItem)).toThrow();
    expect(() => feedItemSchema.parse(topicItem)).toThrow();
    expect(() => feedItemSchema.parse(trendItem)).toThrow();
  });

  it('rejects unknown keys at public Task 1 DTO boundaries', () => {
    const topicItem = { ...feedItemFixture, origin: 'topic' as const, topicId: 'topic-1' };
    const trendItem = { ...feedItemFixture, origin: 'trend' as const, topicId: null };

    expect(() => trendJobDataSchema.parse({
      userId: 'user-a',
      trigger: 'manual',
      internalJobId: 'secret',
    })).toThrow();
    expect(() => topicFeedItemSchema.parse({ ...topicItem, internalRank: 1 })).toThrow();
    expect(() => trendFeedItemSchema.parse({ ...trendItem, internalRank: 1 })).toThrow();
    expect(() => feedItemSchema.parse({ ...topicItem, internalRank: 1 })).toThrow();
    expect(() => feedItemSchema.parse({ ...trendItem, internalRank: 1 })).toThrow();
  });

  it('accepts only the public trend monitor status shape', () => {
    const status = {
      runStatus: 'running' as const,
      nextRunAt: '2026-07-28T04:00:00.000Z',
      intervalHours: 4,
      lastError: null,
      lastRun: {
        id: 'trend-run-1',
        trigger: 'scheduled' as const,
        status: 'running' as const,
        startedAt: '2026-07-28T00:00:00.000Z',
        finishedAt: null,
        newItemCount: null,
      },
    };

    expect(trendStatusSchema.parse(status)).toEqual(status);
    expect(() => trendStatusSchema.parse({ ...status, intervalHours: 1 })).toThrow();
    expect(() => trendStatusSchema.parse({ ...status, leaseToken: 'internal-secret' })).toThrow();
    expect(() => trendStatusSchema.parse({
      ...status,
      lastRun: { ...status.lastRun, connectorFailures: [] },
    })).toThrow();
    expect(() => topicSchema.parse({
      id: 'topic-1',
      userId: 'user-1',
      keyword: 'AI agents',
      expandedTerms: [],
      createdAt: '2026-07-27T00:00:00.000Z',
      lastRunAt: null,
      nextRunAt: null,
      scheduleIntervalHours: 12,
      runStatus: 'running',
      lastError: null,
      lastRun: { ...status.lastRun, connectorFailures: [] },
    })).toThrow();
  });

  it('accepts connector status without trust classifications', () => {
    expect(
      discoverySourceStatusSchema.parse({
        id: 'twitterapi-io',
        label: 'X',
        category: 'social',
        status: 'not_configured',
      }),
    ).toMatchObject({ status: 'not_configured' });
    expect(() =>
      discoverySourceStatusSchema.parse({
        id: ' ',
        label: 'X',
        category: 'social',
        status: 'enabled',
      }),
    ).toThrow();
  });
});
