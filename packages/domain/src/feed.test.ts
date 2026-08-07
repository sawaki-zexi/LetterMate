import type { FeedItem } from '@lettermate/contracts';
import { describe, expect, it } from 'vitest';
import { mergeFeedItems } from './feed.js';

const base = {
  kind: 'quality' as const,
  title: 'Project Aurora 发布稳定版本',
  summary: '该版本增加离线支持、确定性同步、迁移工具和完整的兼容性说明，适合现有团队评估升级路径，并提供逐步回滚方案与跨版本数据校验工具。',
  reason: '包含完整发布说明和迁移细节。',
  sourceUrls: ['https://example.com/aurora'],
  publishedAt: '2026-08-08T00:00:00.000Z',
  discoveredAt: '2026-08-08T01:00:00.000Z',
  sourceType: 'web' as const,
  platform: 'Example',
  authorName: 'Aurora Team',
  authorHandle: null,
  externalId: 'aurora-2',
  provenanceKind: 'fetched_page' as const,
  contentKey: 'https://example.com/aurora',
  feedback: null,
};

const topicItem = (overrides: Partial<FeedItem> = {}): FeedItem => ({
  ...base,
  id: 'topic-item',
  origin: 'topic',
  topicId: 'topic-1',
  topicKeyword: 'Project Aurora',
  topicKeywordActive: true,
  origins: [{
    origin: 'topic', topicId: 'topic-1', topicKeyword: 'Project Aurora',
    topicKeywordActive: true,
  }],
  ...overrides,
} as FeedItem);

const trendItem = (overrides: Partial<FeedItem> = {}): FeedItem => ({
  ...base,
  id: 'trend-item',
  origin: 'trend',
  topicId: null,
  origins: [{ origin: 'trend' }],
  ...overrides,
} as FeedItem);

const creatorItem = (overrides: Partial<FeedItem> = {}): FeedItem => ({
  ...base,
  id: 'creator-item',
  origin: 'creator',
  topicId: null,
  creatorId: 'creator-1',
  creatorName: 'Aurora Maintainer',
  feedEligible: true,
  origins: [{
    origin: 'creator', creatorId: 'creator-1', creatorName: 'Aurora Maintainer',
    platform: 'X', contentType: 'repost',
  }],
  ...overrides,
} as FeedItem);

describe('Feed cross-origin merge', () => {
  it('merges a canonical URL once, prefers explicit Topic content, and keeps every origin', () => {
    const result = mergeFeedItems([
      trendItem({ kind: 'hot', sourceUrls: ['https://example.com/aurora?utm_source=trend'] }),
      creatorItem({ sourceUrls: ['https://x.com/maintainer/status/1'] }),
      topicItem(),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'topic-item', origin: 'topic', kind: 'hot' });
    expect(result[0]?.origins).toEqual([
      { origin: 'trend' },
      {
        origin: 'creator', creatorId: 'creator-1', creatorName: 'Aurora Maintainer',
        platform: 'X', contentType: 'repost',
      },
      {
        origin: 'topic', topicId: 'topic-1', topicKeyword: 'Project Aurora',
        topicKeywordActive: true,
      },
    ]);
    expect(result[0]?.sourceUrls).toEqual([
      'https://example.com/aurora',
      'https://x.com/maintainer/status/1',
    ]);
  });

  it('uses stable platform IDs and substantive fingerprints as transitive merge keys', () => {
    const byExternalId = trendItem({
      id: 'external', contentKey: 'https://mirror.example/aurora', sourceUrls: ['https://mirror.example/aurora'],
    });
    const byFingerprint = creatorItem({
      id: 'fingerprint', externalId: 'different', contentKey: 'https://x.com/maintainer/status/2',
    });

    expect(mergeFeedItems([topicItem(), byExternalId, byFingerprint])).toHaveLength(1);
  });

  it('does not merge unrelated short records from fingerprint alone', () => {
    const first = trendItem({
      id: 'short-1', externalId: null, contentKey: 'https://example.com/one',
      title: '项目更新', summary: '版本一发布。',
    });
    const second = trendItem({
      id: 'short-2', externalId: null, contentKey: 'https://example.com/two',
      title: '项目更新', summary: '版本一发布。',
    });

    expect(mergeFeedItems([first, second])).toHaveLength(2);
  });
});
