import type { FeedItem } from '@lettermate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { DigestScheduleService, localDigestClock } from './digest-scheduler.js';
import { selectDigestSnapshots } from './digest-service.js';

const candidate = (index: number, origin: 'topic' | 'trend' = 'trend'): FeedItem => {
  const base = {
    id: `item-${index}`,
    kind: index % 2 === 0 ? 'hot' as const : 'quality' as const,
    title: `技术更新 ${index}`,
    summary: `已经持久化的中文摘要 ${index}`,
    reason: `推荐理由 ${index}`,
    sourceUrls: [`https://example.com/${index}`],
    publishedAt: null,
    discoveredAt: `2026-08-08T${String(index).padStart(2, '0')}:00:00.000Z`,
    sourceType: 'web' as const,
    platform: 'Example',
    authorName: null,
    authorHandle: null,
    externalId: `${index}`,
    provenanceKind: 'fetched_page' as const,
    contentKey: `https://example.com/${index}`,
    feedback: null,
  };
  return origin === 'topic' ? {
    ...base,
    topicId: 'topic-1', origin: 'topic', topicKeyword: 'GPT', topicKeywordActive: true,
    origins: [{
      origin: 'topic', topicId: 'topic-1', topicKeyword: 'GPT', topicKeywordActive: true,
    }],
  } : {
    ...base, topicId: null, origin: 'trend', origins: [{ origin: 'trend' }],
  };
};

describe('daily digest scheduling', () => {
  it('uses each user timezone to determine the local scheduled date', () => {
    const now = new Date('2026-08-08T00:30:00.000Z');
    expect(localDigestClock(now, 'Asia/Shanghai')).toEqual({
      localDate: '2026-08-08', localTime: '08:30',
    });
    expect(localDigestClock(now, 'America/Los_Angeles')).toEqual({
      localDate: '2026-08-07', localTime: '17:30',
    });
    expect(localDigestClock(
      new Date('2026-03-08T10:30:00.000Z'),
      'America/Los_Angeles',
    )).toEqual({ localDate: '2026-03-08', localTime: '03:30' });
    expect(localDigestClock(
      new Date('2026-11-01T08:30:00.000Z'),
      'America/Los_Angeles',
    ).localDate).toBe('2026-11-01');
    expect(localDigestClock(
      new Date('2026-11-01T09:30:00.000Z'),
      'America/Los_Angeles',
    ).localDate).toBe('2026-11-01');
  });

  it('prepares only due users and enqueues only nonempty queued runs', async () => {
    const repository = {
      listEnabledPreferences: vi.fn().mockResolvedValue([
        { userId: 'user-a', localTime: '08:00', timezone: 'Asia/Shanghai' },
        { userId: 'user-b', localTime: '09:00', timezone: 'Asia/Shanghai' },
      ]),
      ensureRun: vi.fn().mockResolvedValue({
        runId: 'run-a', userId: 'user-a', status: 'queued',
      }),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const now = new Date('2026-08-08T00:30:00.000Z');

    await expect(new DigestScheduleService(repository, queue).scan(now)).resolves.toBe(1);

    expect(repository.ensureRun).toHaveBeenCalledTimes(1);
    expect(repository.ensureRun).toHaveBeenCalledWith({
      userId: 'user-a', scheduledLocalDate: '2026-08-08', windowEnd: now, now,
    });
    expect(queue.add).toHaveBeenCalledWith(
      'deliver-digest',
      { runId: 'run-a', userId: 'user-a' },
      expect.objectContaining({
        jobId: 'digest-run-a', attempts: 4, backoff: { type: 'digest' },
      }),
    );
  });

  it('does not call the queue for an empty skipped run', async () => {
    const repository = {
      listEnabledPreferences: vi.fn().mockResolvedValue([
        { userId: 'user-a', localTime: '08:00', timezone: 'Asia/Shanghai' },
      ]),
      ensureRun: vi.fn().mockResolvedValue({
        runId: 'run-a', userId: 'user-a', status: 'skipped',
      }),
    };
    const queue = { add: vi.fn() };

    await expect(new DigestScheduleService(repository, queue).scan(
      new Date('2026-08-08T00:30:00.000Z'),
    )).resolves.toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('daily digest snapshot selection', () => {
  it('excludes delivered keys, preserves subscriptions, and freezes at ten items', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(
      index,
      index === 0 ? 'topic' : 'trend',
    ));
    const snapshots = selectDigestSnapshots({
      candidates,
      profiles: [],
      tags: [],
      adjacencies: [],
      forgottenTagIds: [],
      deliveredContentKeys: new Set([`${candidates[11]!.contentKey}?utm_source=digest`]),
      asOf: new Date('2026-08-08T12:00:00.000Z'),
    });

    expect(snapshots).toHaveLength(10);
    expect(snapshots[0]?.contentKey).toBe(candidates[0]?.contentKey);
    expect(snapshots.some((item) => item.contentKey === candidates[11]?.contentKey)).toBe(false);
    expect(snapshots[0]).toEqual({
      contentKey: 'https://example.com/0',
      position: 0,
      title: '技术更新 0',
      summary: '已经持久化的中文摘要 0',
      reason: '推荐理由 0',
      sourceUrl: 'https://example.com/0',
      citationUrls: ['https://example.com/0'],
      platform: 'Example',
      publishedAt: null,
      evidence: '推荐理由 0',
      uncertainty: '邮件摘要仅基于已验证的原始来源，不替代对完整原文的独立核验。',
      followUp: '打开原文核验关键细节，并继续关注后续更新或独立来源。',
    });
  });

  it('deduplicates origins, ranks direct interests, and excludes adjacent exploration', () => {
    const followed = candidate(0, 'topic');
    const duplicateTrend = {
      ...candidate(1),
      id: 'trend-duplicate',
      contentKey: followed.contentKey,
      sourceUrls: followed.sourceUrls,
      externalId: followed.externalId,
    } as FeedItem;
    const directInterest = candidate(2);
    const adjacentExploration = candidate(3);
    const ordinaryTrend = candidate(4);
    const snapshots = selectDigestSnapshots({
      candidates: [ordinaryTrend, adjacentExploration, duplicateTrend, directInterest, followed],
      profiles: [{
        tagId: 'tag-core', shortScore: 5, longScore: 3, negativeScore: 0,
        evidenceUpdatedAt: '2026-08-08T08:00:00.000Z', sourceKinds: ['interested'],
      }],
      tags: [
        { contentKey: directInterest.contentKey, tagId: 'tag-core', confidence: 0.95 },
        { contentKey: adjacentExploration.contentKey, tagId: 'tag-edge', confidence: 0.95 },
        { contentKey: followed.contentKey, tagId: 'tag-edge', confidence: 0.95 },
      ],
      adjacencies: [{ leftTagId: 'tag-core', rightTagId: 'tag-edge' }],
      forgottenTagIds: [],
      deliveredContentKeys: new Set(),
      asOf: new Date('2026-08-08T12:00:00.000Z'),
    });

    expect(snapshots.filter((item) => item.contentKey === followed.contentKey)).toHaveLength(1);
    expect(snapshots.some((item) => item.contentKey === adjacentExploration.contentKey)).toBe(false);
    expect(snapshots.map((item) => item.contentKey)).toEqual([
      followed.contentKey,
      directInterest.contentKey,
      ordinaryTrend.contentKey,
    ]);
  });
});
