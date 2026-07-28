import { describe, expect, it } from 'vitest';
import {
  discoveryItemSchema,
  discoveryJobDataSchema,
  discoveryQueueName,
  discoveryResultSchema,
  discoverySourceStatusSchema,
  feedItemSchema,
  feedOriginSchema,
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

  it('accepts public run summaries and rejects invalid item counts', () => {
    const run = runSummarySchema.parse({
      id: 'run-1',
      trigger: 'manual',
      status: 'succeeded',
      startedAt: '2026-07-28T00:00:00.000Z',
      finishedAt: '2026-07-28T00:01:00.000Z',
      newItemCount: 3,
    });

    expect(run).toMatchObject({ newItemCount: 3 });
    expect(() => runSummarySchema.parse({ ...run, newItemCount: -1 })).toThrow();
    expect(() => runSummarySchema.parse({ ...run, newItemCount: 1.5 })).toThrow();
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

  it('shares a stable trend queue and accepts trigger-aware trend jobs', () => {
    expect(trendQueueName).toBe('trend-discovery');
    expect(trendJobDataSchema.parse({ userId: 'user-a', trigger: 'manual' })).toEqual({
      userId: 'user-a',
      trigger: 'manual',
    });
  });

  it('discriminates topic and trend feed items by origin', () => {
    const baseItem = {
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
    const topicItem = { ...baseItem, origin: 'topic' as const, topicId: 'topic-1' };
    const trendItem = { ...baseItem, origin: 'trend' as const, topicId: null };

    expect(topicFeedItemSchema.parse(topicItem).origin).toBe('topic');
    expect(trendFeedItemSchema.parse(trendItem).origin).toBe('trend');
    expect(feedItemSchema.parse(topicItem).topicId).toBe('topic-1');
    expect(feedItemSchema.parse(trendItem).topicId).toBeNull();
    expect(() => feedItemSchema.parse({ ...topicItem, topicId: null })).toThrow();
    expect(() => feedItemSchema.parse({ ...trendItem, topicId: 'topic-1' })).toThrow();
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
