import { describe, expect, it } from 'vitest';
import {
  authLoginInputSchema,
  authRegisterInputSchema,
  authSessionSchema,
  agentRunStageSchema,
  creatorInputSchema,
  creatorIdentityCandidateSchema,
  creatorPlatformStatusSchema,
  creatorResolutionInputSchema,
  creatorResolutionResultSchema,
  creatorJobDataSchema,
  creatorSchema,
  discoveryItemSchema,
  discoveryJobDataSchema,
  discoveryQueueName,
  discoveryResultSchema,
  discoverySourceStatusSchema,
  contentFeedbackSchema,
  savedContentBatchInputSchema,
  savedContentBatchSchema,
  savedContentInputSchema,
  savedContentSchema,
  feedbackInputSchema,
  feedImpressionInputSchema,
  feedImpressionReceiptSchema,
  interestEventSchema,
  interestTagExtractionSchema,
  interestMemorySchema,
  interestMemorySettingsInputSchema,
  operationalLogSchema,
  digestPreferenceInputSchema,
  digestPreferenceSchema,
  digestJobDataSchema,
  digestPreviewSchema,
  digestQueueName,
  digestRecentRunSchema,
  digestStatusSchema,
  digestUnsubscribeInputSchema,
  digestUnsubscribeResultSchema,
  feedItemSchema,
  feedPageSchema,
  feedOriginSchema,
  feedQuerySchema,
  feedRangeSchema,
  readinessSchema,
  runSummarySchema,
  sourceTypeSchema,
  topicFeedItemSchema,
  topicSchema,
  topicInputSchema,
  topicUpdateInputSchema,
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
  contentKey: 'https://example.com/project',
  feedback: null,
};

const topicOriginFixture = {
  origin: 'topic' as const,
  topicId: 'topic-1',
  topicKeyword: 'AI agents',
  topicKeywordActive: true,
};

const trendOriginFixture = { origin: 'trend' as const };

describe('AI discovery contracts', () => {
  it('parses bounded Feed pagination and page responses', () => {
    expect(feedQuerySchema.parse({ limit: '20' })).toMatchObject({
      range: '30d', origin: 'all', limit: 20,
    });
    expect(feedQuerySchema.parse({ cursor: 'abc_123-XYZ' })).toMatchObject({
      cursor: 'abc_123-XYZ', limit: 30,
    });
    expect(() => feedQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => feedQuerySchema.parse({ limit: '51' })).toThrow();
    expect(() => feedQuerySchema.parse({ cursor: 'not a cursor' })).toThrow();
    expect(feedPageSchema.parse({
      items: [], nextCursor: null, truncated: false,
    })).toEqual({ items: [], nextCursor: null, truncated: false });
  });

  it('accepts only versioned, exact interest events', () => {
    const event = {
      id: 'event-1',
      userId: 'user-1',
      eventType: 'topic_state' as const,
      sourceRef: 'topic-1',
      payload: {
        schemaVersion: 1 as const,
        state: 'active' as const,
        topicId: 'topic-1',
        keyword: 'GPT-5.7',
        normalizedKeyword: 'gpt-5.7',
      },
      occurredAt: '2026-08-08T08:00:00.000Z',
      recordedAt: '2026-08-08T08:00:00.000Z',
      supersededAt: null,
    };
    expect(interestEventSchema.parse(event)).toEqual(event);
    expect(() => interestEventSchema.parse({
      ...event, payload: { ...event.payload, schemaVersion: 2 },
    })).toThrow();
    expect(() => interestEventSchema.parse({
      ...event, payload: { ...event.payload, inferredPreference: true },
    })).toThrow();
  });

  it('accepts one to five controlled interest tags only', () => {
    expect(interestTagExtractionSchema.parse({
      schemaVersion: 1,
      tags: [{
        slug: 'gpt-5-7', displayName: 'GPT-5.7', kind: 'entity', confidence: 0.95,
      }],
    }).tags).toHaveLength(1);
    expect(() => interestTagExtractionSchema.parse({ schemaVersion: 1, tags: [] })).toThrow();
    expect(() => interestTagExtractionSchema.parse({
      schemaVersion: 1,
      tags: [{ slug: 'Broad AI', displayName: 'AI', kind: 'broad', confidence: 2 }],
    })).toThrow();
  });

  it('shares one stable discovery queue name', () => {
    expect(discoveryQueueName).toBe('topic-discovery');
  });

  it('accepts exactly one trimmed keyword', () => {
    expect(topicInputSchema.parse({ keyword: '  AI Agent  ' })).toEqual({ keyword: 'AI Agent' });
    expect(() => topicInputSchema.parse({ keyword: '' })).toThrow();
    expect(() => topicInputSchema.parse({ keyword: 'x'.repeat(101) })).toThrow();
  });

  it('accepts only a trimmed keyword for updates', () => {
    expect(topicUpdateInputSchema.parse({ keyword: '  gpt-5.7  ' })).toEqual({ keyword: 'gpt-5.7' });
    expect(() => topicUpdateInputSchema.parse({ keyword: '' })).toThrow();
  });

  it('accepts a public RSS creator subscription and safe job shape', () => {
    expect(creatorInputSchema.parse({ url: 'https://example.com/feed.xml' })).toEqual({
      url: 'https://example.com/feed.xml',
    });
    expect(() => creatorInputSchema.parse({ url: 'file:///private/feed.xml' })).toThrow();
    expect(creatorResolutionInputSchema.parse({ input: '  Example Author  ' })).toEqual({
      input: 'Example Author',
    });
    expect(creatorInputSchema.parse({ resolutionTokens: ['x'.repeat(32)] })).toEqual({
      resolutionTokens: ['x'.repeat(32)],
    });
    const candidate = {
      resolutionToken: 'x'.repeat(32),
      platform: 'rss' as const,
      displayName: 'Example Author',
      handle: null,
      avatarUrl: null,
      bio: 'Engineering notes',
      verified: null,
      profileUrl: 'https://example.com/',
      feedUrl: 'https://example.com/feed.xml',
    };
    expect(creatorIdentityCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(creatorResolutionResultSchema.parse({ candidates: [candidate] })).toEqual({
      candidates: [candidate],
    });
    expect(creatorPlatformStatusSchema.parse({
      id: 'rss', label: 'RSS/Atom', status: 'enabled',
    })).toEqual({ id: 'rss', label: 'RSS/Atom', status: 'enabled' });
    expect(creatorIdentityCandidateSchema.parse({
      ...candidate,
      platform: 'x',
      handle: '@example',
      profileUrl: 'https://x.com/example',
      feedUrl: null,
    })).toMatchObject({ platform: 'x', handle: '@example', feedUrl: null });
    expect(creatorIdentityCandidateSchema.parse({
      ...candidate,
      platform: 'bilibili',
      handle: 'UID 946974',
      profileUrl: 'https://space.bilibili.com/946974',
      feedUrl: null,
    })).toMatchObject({ platform: 'bilibili', handle: 'UID 946974', feedUrl: null });
    expect(creatorIdentityCandidateSchema.parse({
      ...candidate,
      platform: 'youtube',
      handle: '@example',
      profileUrl: 'https://www.youtube.com/channel/UC1234567890123456789012',
      feedUrl: null,
    })).toMatchObject({ platform: 'youtube', handle: '@example', feedUrl: null });
    expect(creatorIdentityCandidateSchema.parse({
      ...candidate,
      platform: 'bluesky',
      handle: '@example.bsky.social',
      profileUrl: 'https://bsky.app/profile/example.bsky.social',
      feedUrl: null,
    })).toMatchObject({ platform: 'bluesky', handle: '@example.bsky.social', feedUrl: null });
    expect(creatorJobDataSchema.parse({
      creatorId: 'creator-1', userId: 'user-1', trigger: 'scheduled',
    })).toEqual({ creatorId: 'creator-1', userId: 'user-1', trigger: 'scheduled' });
    expect(creatorSchema.parse({
      id: 'creator-1', userId: 'user-1', platform: 'rss', displayName: 'Example',
      profileUrl: 'https://example.com/feed.xml', feedUrl: 'https://example.com/feed.xml',
      createdAt: '2026-08-06T08:00:00.000Z', pausedAt: null, lastRunAt: null,
      nextRunAt: null, runStatus: 'queued', lastError: null, lastRun: null,
    })).toMatchObject({ id: 'creator-1', platform: 'rss' });
  });

  it('rejects expanded terms duplicated after Unicode normalization', () => {
    const result = topicUpdateInputSchema.safeParse({
      keyword: 'gpt-5.7',
      expandedTerms: ['GPT 5.7', '  gpt   5.7  ', 'ＧＰＴ ５.７'],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['expandedTerms', 1], message: '扩展词不能重复' }),
        expect.objectContaining({ path: ['expandedTerms', 2], message: '扩展词不能重复' }),
      ]));
    }
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
    expect(feedOriginSchema.options).toEqual(['all', 'topic', 'trend', 'creator']);
    expect(() => feedRangeSchema.parse('archive')).toThrow();
    expect(() => feedOriginSchema.parse('keyword')).toThrow();
  });

  it('normalizes persisted Feed search queries with existing filters', () => {
    expect(feedQuerySchema.parse({
      q: '  智能体工程  ', range: '30d', origin: 'topic', kind: 'quality',
    })).toEqual({
      q: '智能体工程', range: '30d', origin: 'topic', kind: 'quality', limit: 30,
    });
    expect(feedQuerySchema.parse({ q: '   ' })).toEqual({
      q: undefined, range: '30d', origin: 'all', limit: 30,
    });
    expect(() => feedQuerySchema.parse({ q: 'x'.repeat(101) })).toThrow();
    expect(() => feedQuerySchema.parse({
      topicId: 'topic-1', origin: 'trend',
    })).toThrow();
    expect(() => feedQuerySchema.parse({
      topicId: 'topic-1', origin: 'creator',
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
        status: 'degraded' as const,
        finishedAt: '2026-07-28T00:01:00.000Z',
        newItemCount: 2,
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
      'degraded',
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
      pausedAt: null,
      lastRunAt: null,
      nextRunAt: '2026-07-28T00:00:00.000Z',
      scheduleIntervalHours: 12,
      runStatus: 'succeeded',
      lastError: null,
      lastRun: null,
    });

    expect(topic).toMatchObject({
      pausedAt: null,
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
    const topicItem = {
      ...feedItemFixture,
      origin: 'topic' as const,
      topicId: 'topic-1',
      topicKeyword: 'AI agents',
      topicKeywordActive: true,
      origins: [topicOriginFixture],
    };
    const trendItem = {
      ...feedItemFixture, origin: 'trend' as const, topicId: null, origins: [trendOriginFixture],
    };

    expect(topicFeedItemSchema.parse(topicItem).origin).toBe('topic');
    expect(trendFeedItemSchema.parse(trendItem).origin).toBe('trend');
    expect(feedItemSchema.parse(topicItem).topicId).toBe('topic-1');
    expect(feedItemSchema.parse(trendItem).topicId).toBeNull();
    expect(() => feedItemSchema.parse({ ...topicItem, topicId: null })).toThrow();
    expect(() => feedItemSchema.parse({ ...trendItem, topicId: 'topic-1' })).toThrow();
    expect(() => topicFeedItemSchema.parse({ ...topicItem, topicKeyword: '' })).toThrow();
    expect(() => topicFeedItemSchema.parse({ ...topicItem, topicKeywordActive: 'true' })).toThrow();
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
        topicKeyword: 'AI agents',
        topicKeywordActive: true,
        origins: [topicOriginFixture],
      };
      const trendItem = {
        ...feedItemFixture,
        sourceUrls: [sourceUrl],
        origin: 'trend' as const,
        topicId: null,
        origins: [trendOriginFixture],
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
      topicKeyword: 'AI agents',
      topicKeywordActive: true,
      origins: [topicOriginFixture],
    };
    const trendItem = {
      ...feedItemFixture,
      sourceUrls: [sourceUrl],
      origin: 'trend' as const,
      topicId: null,
      origins: [trendOriginFixture],
    };

    expect(() => discoveryResultSchema.parse({ citations: [sourceUrl], items: [] })).toThrow();
    expect(() => topicFeedItemSchema.parse(topicItem)).toThrow();
    expect(() => trendFeedItemSchema.parse(trendItem)).toThrow();
    expect(() => feedItemSchema.parse(topicItem)).toThrow();
    expect(() => feedItemSchema.parse(trendItem)).toThrow();
  });

  it('rejects unknown keys at public Task 1 DTO boundaries', () => {
    const topicItem = {
      ...feedItemFixture,
      origin: 'topic' as const,
      topicId: 'topic-1',
      topicKeyword: 'AI agents',
      topicKeywordActive: true,
      origins: [topicOriginFixture],
    };
    const trendItem = {
      ...feedItemFixture, origin: 'trend' as const, topicId: null, origins: [trendOriginFixture],
    };

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

  it('accepts only explicit persisted feedback states', () => {
    expect(feedbackInputSchema.parse({ value: 'interested' })).toEqual({ value: 'interested' });
    expect(feedbackInputSchema.parse({ value: 'less' })).toEqual({ value: 'less' });
    expect(feedbackInputSchema.parse({ value: null })).toEqual({ value: null });
    expect(() => feedbackInputSchema.parse({ value: 'like' })).toThrow();
    expect(() => feedbackInputSchema.parse({ value: null, score: 1 })).toThrow();
    expect(contentFeedbackSchema.parse({
      contentKey: 'https://example.com/article', value: 'interested',
    })).toEqual({ contentKey: 'https://example.com/article', value: 'interested' });
    expect(savedContentInputSchema.parse({ state: 'saved' })).toEqual({ state: 'saved' });
    expect(savedContentSchema.parse({
      contentKey: 'https://example.com/article', state: 'archived',
    })).toEqual({ contentKey: 'https://example.com/article', state: 'archived' });
    expect(savedContentInputSchema.parse({ state: null })).toEqual({ state: null });
    expect(() => savedContentInputSchema.parse({ state: 'unknown' })).toThrow();
    expect(savedContentBatchInputSchema.parse({
      contentKeys: ['https://example.com/a', 'https://example.com/b'], state: 'archived',
    })).toEqual({
      contentKeys: ['https://example.com/a', 'https://example.com/b'], state: 'archived',
    });
    expect(savedContentBatchSchema.parse({ items: [
      { contentKey: 'https://example.com/a', state: 'archived' },
    ] })).toEqual({ items: [{ contentKey: 'https://example.com/a', state: 'archived' }] });
    expect(() => savedContentBatchInputSchema.parse({
      contentKeys: ['https://example.com/a', 'https://example.com/a'], state: 'archived',
    })).toThrow();
    expect(() => savedContentBatchInputSchema.parse({
      contentKeys: ['https://example.com/a'], state: 'saved',
    })).toThrow();
  });

  it('exposes recommendation context and interest memory without internal scores', () => {
    const recommendation = {
      lane: 'interest' as const,
      reason: 'related_interest' as const,
      isExploration: false,
    };
    const memory = {
      personalizationEnabled: true,
      resetAt: null,
      recent: [{
        id: 'opaque-theme-1',
        name: 'AI Agents',
        kind: 'topic' as const,
        sources: ['keyword', 'feedback'] as const,
        updatedAt: '2026-08-08T08:00:00.000Z',
      }],
      longTerm: [],
      reduced: [],
    };
    expect(feedItemSchema.parse({
      ...feedItemFixture,
      origin: 'trend', topicId: null, origins: [trendOriginFixture], recommendation,
    }).recommendation).toEqual(recommendation);
    expect(interestMemorySchema.parse(memory)).toEqual(memory);
    expect(interestMemorySettingsInputSchema.parse({ personalizationEnabled: false }))
      .toEqual({ personalizationEnabled: false });
    expect(() => interestMemorySchema.parse({ ...memory, internalScore: 1 })).toThrow();
    expect(() => interestMemorySchema.parse({
      ...memory,
      recent: [{ ...memory.recent[0], weight: 0.9 }],
    })).toThrow();
    expect(() => feedItemSchema.parse({
      ...feedItemFixture,
      origin: 'trend', topicId: null, origins: [trendOriginFixture],
      recommendation: { ...recommendation, score: 9 },
    })).toThrow();
    expect(feedImpressionInputSchema.parse({
      decisionId: 'decision-1',
      contentKeys: ['https://example.com/article', 'https://example.com/other'],
    })).toEqual({
      decisionId: 'decision-1',
      contentKeys: ['https://example.com/article', 'https://example.com/other'],
    });
    expect(() => feedImpressionInputSchema.parse({
      decisionId: 'decision-1',
      contentKeys: ['https://example.com/article', 'https://EXAMPLE.com/article'],
    })).toThrow();
    expect(feedImpressionReceiptSchema.parse({ recorded: 2 })).toEqual({ recorded: 2 });
  });

  it('accepts only safe daily digest preferences and persisted preview fields', () => {
    const preference = { enabled: true, localTime: '08:30', timezone: 'Asia/Shanghai' };
    expect(digestPreferenceInputSchema.parse(preference)).toEqual(preference);
    expect(digestPreferenceSchema.parse(preference)).toEqual(preference);
    expect(() => digestPreferenceInputSchema.parse({
      ...preference, localTime: '24:00',
    })).toThrow();
    expect(() => digestPreferenceInputSchema.parse({
      ...preference, timezone: 'Shanghai',
    })).toThrow();
    expect(() => digestPreferenceInputSchema.parse({
      ...preference, recipientEmail: 'other@example.com',
    })).toThrow();

    const preview = {
      generatedAt: '2026-08-08T08:00:00.000Z',
      items: [{
        contentKey: 'https://example.com/article',
        title: '技术更新',
        summary: '已经持久化的中文摘要。',
        reason: '包含重要且可回溯的变化。',
        sourceUrl: 'https://example.com/article',
        publishedAt: '2026-08-08T07:00:00.000Z',
        platform: 'Example',
        brief: {
          conclusion: '已经持久化的中文摘要。',
          evidence: '包含重要且可回溯的变化。',
          uncertainty: '仍需核验原文。',
          followUp: '继续关注后续更新。',
        },
        citations: [{
          contentKey: 'https://example.com/article',
          url: 'https://example.com/article',
          platform: 'Example',
          publishedAt: '2026-08-08T07:00:00.000Z',
        }],
      }],
    };
    expect(digestPreviewSchema.parse(preview)).toEqual(preview);
    expect(() => digestPreviewSchema.parse({
      ...preview, items: [{ ...preview.items[0], score: 9 }],
    })).toThrow();

    expect(digestQueueName).toBe('daily-digest');
    expect(digestJobDataSchema.parse({ runId: 'run-1', userId: 'user-a' })).toEqual({
      runId: 'run-1', userId: 'user-a',
    });
    const recentRun = {
      status: 'succeeded' as const,
      scheduledLocalDate: '2026-08-08',
      finishedAt: '2026-08-08T00:01:00.000Z',
      itemCount: 3,
    };
    expect(digestRecentRunSchema.parse(recentRun)).toEqual(recentRun);
    const status = {
      deliveryCapability: 'configured' as const,
      nextLocalSend: {
        localDate: '2026-08-09', localTime: '08:30', timezone: 'Asia/Shanghai',
      },
      recentRun: null,
    };
    expect(digestStatusSchema.parse(status)).toEqual(status);
    expect(() => digestStatusSchema.parse({
      ...status, smtpHost: 'smtp.example.com',
    })).toThrow();
    expect(() => digestRecentRunSchema.parse({
      ...recentRun, providerMessageId: 'provider-secret',
    })).toThrow();

    expect(authLoginInputSchema.parse({
      email: 'student@example.com', password: 'correct horse battery staple',
    })).toEqual({ email: 'student@example.com', password: 'correct horse battery staple' });
    expect(authRegisterInputSchema.parse({
      email: 'student@example.com', password: 'correct horse battery staple',
    })).toEqual({
      email: 'student@example.com', password: 'correct horse battery staple',
      timezone: 'Asia/Shanghai',
    });
    expect(authSessionSchema.parse({
      authenticated: false, user: null, csrfToken: null,
    })).toEqual({ authenticated: false, user: null, csrfToken: null });
  });

  it('accepts only bounded opaque digest unsubscribe requests and safe results', () => {
    const token = `v1.${'1'.repeat(36)}.${'a'.repeat(43)}`;
    expect(digestUnsubscribeInputSchema.parse({ token })).toEqual({ token });
    expect(digestUnsubscribeResultSchema.parse({ status: 'unsubscribed' }))
      .toEqual({ status: 'unsubscribed' });
    expect(() => digestUnsubscribeInputSchema.parse({ token: 'short' })).toThrow();
    expect(() => digestUnsubscribeResultSchema.parse({
      status: 'unsubscribed', userId: 'user-a',
    })).toThrow();
  });

  it('accepts only safe readiness dependency states', () => {
    expect(readinessSchema.parse({
      status: 'degraded',
      timestamp: '2026-08-05T00:00:00.000Z',
      dependencies: {
        database: { status: 'ok' },
        redis: { status: 'error', code: 'REDIS_UNAVAILABLE' },
        ai: { status: 'not_configured', code: 'AI_NOT_CONFIGURED' },
      },
    }).status).toBe('degraded');
    expect(() => readinessSchema.parse({
      status: 'ok',
      timestamp: '2026-08-05T00:00:00.000Z',
      dependencies: { redis: { status: 'error', message: 'secret' } },
    })).toThrow();
  });

  it('accepts bounded operational logs without arbitrary sensitive fields', () => {
    expect(operationalLogSchema.parse({
      timestamp: '2026-08-08T08:00:00.000Z',
      level: 'error',
      service: 'worker',
      event: 'queue.job.failed',
      runId: 'run-1',
      jobId: 'job-1',
      queue: 'topic-discovery',
      attempt: 3,
      code: 'JOB_FAILED',
    })).toMatchObject({ event: 'queue.job.failed', runId: 'run-1' });
    expect(operationalLogSchema.parse({
      timestamp: '2026-08-08T08:00:00.000Z',
      level: 'info',
      service: 'worker',
      event: 'agent.stage.completed',
      component: 'topic',
      runId: 'run-1',
      stage: agentRunStageSchema.parse('quality_gate'),
      durationMs: 25,
      metrics: { inputCount: 10, outputCount: 2, failureCount: 1 },
    })).toMatchObject({ stage: 'quality_gate', metrics: { outputCount: 2 } });
    expect(() => operationalLogSchema.parse({
      timestamp: '2026-08-08T08:00:00.000Z',
      level: 'info',
      service: 'api',
      event: 'request.completed',
      email: 'student@example.com',
    })).toThrow();
  });
});
