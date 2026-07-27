import { describe, expect, it } from 'vitest';
import {
  discoveryItemSchema,
  discoveryJobDataSchema,
  discoveryQueueName,
  discoveryResultSchema,
  discoverySourceStatusSchema,
  feedRangeSchema,
  sourceTypeSchema,
  topicSchema,
  topicInputSchema,
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

  it('accepts source categories and feed ranges', () => {
    expect(sourceTypeSchema.options).toEqual([
      'web',
      'feed',
      'social',
      'video',
      'community',
      'code',
      'paper',
    ]);
    expect(feedRangeSchema.parse('all')).toBe('all');
    expect(() => feedRangeSchema.parse('archive')).toThrow();
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
    });

    expect(topic).toMatchObject({
      nextRunAt: '2026-07-28T00:00:00.000Z',
      scheduleIntervalHours: 12,
    });
    expect(() => topicSchema.parse({ ...topic, scheduleIntervalHours: 8 })).toThrow();
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
