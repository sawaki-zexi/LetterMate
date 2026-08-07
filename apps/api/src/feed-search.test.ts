import type { FeedItem } from '@lettermate/contracts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildTopicRankQuery,
  buildTrendRankQuery,
  sortRankedFeed,
} from './feed-search.js';

const feedItem = (
  id: string,
  origin: 'topic' | 'trend',
  publishedAt: string | null,
  discoveredAt: string,
): FeedItem => {
  const base = {
  id,
  kind: 'quality' as const,
  title: id,
  summary: '摘要',
  reason: '推荐理由',
  sourceUrls: [`https://example.com/${id}`],
  publishedAt,
  discoveredAt,
  sourceType: 'web' as const,
  platform: 'Example',
  authorName: null,
  authorHandle: null,
  externalId: null,
  provenanceKind: 'fetched_page' as const,
  contentKey: `https://example.com/${id}`,
  feedback: null,
  };
  return origin === 'topic'
    ? {
        ...base,
        origin,
        topicId: 'topic-1',
        topicKeyword: 'AI Agent',
        topicKeywordActive: true,
        origins: [{
          origin: 'topic' as const, topicId: 'topic-1',
          topicKeyword: 'AI Agent', topicKeywordActive: true,
        }],
      }
    : { ...base, origin, topicId: null, origins: [{ origin: 'trend' as const }] };
};

describe('persisted Feed search', () => {
  it('enables trigram search for every searchable stored article field', () => {
    const sql = readFileSync(
      'prisma/migrations/20260802_feed_search_trigrams/migration.sql',
      'utf8',
    );

    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    for (const table of ['DiscoveryItem', 'RadarItem']) {
      for (const field of ['title', 'summary', 'reason']) {
        expect(sql).toContain(`ON "${table}" USING GIN ("${field}" gin_trgm_ops)`);
      }
    }
  });

  it('sorts merged Topic and trend matches by relevance, effective time, then id', () => {
    const oldStrong = feedItem(
      'a-old-strong', 'topic', '2026-08-01T08:00:00.000Z', '2026-08-01T09:00:00.000Z',
    );
    const newStrong = feedItem(
      'b-new-strong', 'trend', null, '2026-08-02T08:00:00.000Z',
    );
    const sameTimeHigherId = feedItem(
      'c-new-strong', 'topic', null, '2026-08-02T08:00:00.000Z',
    );
    const weak = feedItem(
      'z-weak', 'trend', '2026-08-03T08:00:00.000Z', '2026-08-03T09:00:00.000Z',
    );

    expect(sortRankedFeed([
      { item: oldStrong, relevance: 3.4 },
      { item: weak, relevance: 2.7 },
      { item: newStrong, relevance: 3.4 },
      { item: sameTimeHigherId, relevance: 3.4 },
    ])).toEqual([sameTimeHigherId, newStrong, oldStrong, weak]);
  });

  it('builds parameterized owner-scoped rank queries with all Feed filters', () => {
    const filter = {
      origin: 'all' as const,
      topicId: 'topic-1',
      kind: 'quality' as const,
      since: new Date('2026-08-01T00:00:00.000Z'),
      query: '100%_\\',
    };
    const topicSql = buildTopicRankQuery('user-a', filter);
    const { topicId: _topicId, ...trendFilter } = filter;
    const trendSql = buildTrendRankQuery('user-a', trendFilter);
    const topicText = topicSql.strings.join('?');
    const trendText = trendSql.strings.join('?');

    expect(topicText).toContain('JOIN "Topic" topic');
    expect(topicText).toContain('topic."userId" =');
    expect(topicText).toContain('item."topicId" =');
    expect(topicText).toContain('item."kind" =');
    expect(topicText).toContain('COALESCE(item."publishedAt", item."discoveredAt") >=');
    expect(topicSql.values).toEqual(expect.arrayContaining([
      'user-a', 'topic-1', 'quality', filter.since, '100%_\\', '%100\\%\\_\\\\%',
    ]));

    expect(trendText).toContain('item."userId" =');
    expect(trendText).not.toContain('JOIN "Topic"');
    expect(trendSql.values).toContain('user-a');
  });
});
