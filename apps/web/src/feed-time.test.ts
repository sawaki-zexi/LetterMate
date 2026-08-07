import type { FeedItem } from '@lettermate/contracts';
import { describe, expect, it } from 'vitest';
import { groupFeedItems } from './feed-time.js';

function item(
  id: string,
  discoveredAt: string,
  publishedAt: string | null = null,
): FeedItem {
  return {
    id,
    origin: 'topic',
    topicId: 'topic-1',
    topicKeyword: 'gpt-5.7',
    topicKeywordActive: true,
    kind: 'quality',
    title: id,
    summary: '摘要',
    reason: '理由',
    sourceUrls: ['https://example.com/source'],
    publishedAt,
    discoveredAt,
    sourceType: 'web',
    platform: 'Example',
    authorName: null,
    authorHandle: null,
    externalId: null,
    provenanceKind: 'fetched_page',
    contentKey: 'https://example.com/source',
    feedback: null,
    origins: [{
      origin: 'topic', topicId: 'topic-1', topicKeyword: 'gpt-5.7', topicKeywordActive: true,
    }],
  };
}

describe('groupFeedItems', () => {
  it('uses mutually exclusive calendar-day groups and omits empty groups', () => {
    const now = new Date(2026, 6, 28, 12);
    const items = [
      item('today', '2026-07-28T00:00:00'),
      item('yesterday', '2026-07-27T00:00:00'),
      item('three-days', '2026-07-26T00:00:00'),
      item('seven-days', '2026-07-22T00:00:00'),
      item('month', '2026-07-01T00:00:00'),
      item('older', '2026-06-30T23:59:59'),
    ];

    expect(groupFeedItems(items, now).map((group) => [
      group.label,
      group.items.map((entry) => entry.id),
    ])).toEqual([
      ['今天', ['today']],
      ['昨天', ['yesterday']],
      ['近 3 天', ['three-days']],
      ['近 7 天', ['seven-days']],
      ['本月更早', ['month']],
      ['更早', ['older']],
    ]);
  });

  it('uses published time when available and preserves API order within a group', () => {
    const now = new Date(2026, 6, 28, 12);
    const items = [
      item('first', '2026-07-01T08:00:00', '2026-07-28T10:00:00'),
      item('second', '2026-07-28T11:00:00'),
      item('published-older', '2026-07-28T11:30:00', '2026-06-01T00:00:00'),
    ];

    expect(groupFeedItems(items, now).map((group) => [
      group.label,
      group.items.map((entry) => entry.id),
    ])).toEqual([
      ['今天', ['first', 'second']],
      ['更早', ['published-older']],
    ]);
  });
});
