import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import {
  buildTopicRankQuery,
  buildTrendRankQuery,
  type RankedId,
} from './feed-search.js';
import { InvalidFeedCursorError } from './feed-pagination.js';
import { PrismaTopicStore } from './topic-store.js';

const databaseIt = process.env.RUN_DATABASE_TESTS === '1' ? it : it.skip;
const snapshotAt = new Date('2026-08-16T12:00:00.000Z');
const discoveredAt = new Date('2026-08-16T08:00:00.000Z');

databaseIt('executes owner-scoped Feed search and stable cursor pages in PostgreSQL', async () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID();
  const userId = `feed-db-owner-${suffix}`;
  const otherUserId = `feed-db-other-${suffix}`;
  const secret = `feed-db-secret-${suffix}`;
  try {
    await prisma.user.createMany({
      data: [
        {
          id: userId,
          email: `${userId}@example.test`,
          passwordHash: 'test-password-hash',
          timezone: 'UTC',
        },
        {
          id: otherUserId,
          email: `${otherUserId}@example.test`,
          passwordHash: 'test-password-hash',
          timezone: 'UTC',
        },
      ],
    });
    const [topic, otherTopic] = await Promise.all([
      prisma.topic.create({
        data: {
          userId,
          keyword: 'AI Agent',
          normalizedKeyword: 'ai agent',
          runStatus: 'succeeded',
        },
      }),
      prisma.topic.create({
        data: {
          userId: otherUserId,
          keyword: 'AI Agent private',
          normalizedKeyword: 'ai agent private',
          runStatus: 'succeeded',
        },
      }),
    ]);
    const [topicItem, otherTopicItem] = await Promise.all([
      prisma.discoveryItem.create({
        data: {
          topicId: topic.id,
          kind: 'quality',
          title: 'AI Agent topic result',
          summary: 'Owner-scoped topic search result.',
          reason: 'Matches the monitored AI Agent topic.',
          sourceUrls: [`https://example.test/topic-${suffix}`],
          canonicalPrimaryUrl: `https://example.test/topic-${suffix}`,
          publishedAt: new Date('2026-08-16T07:00:00.000Z'),
          discoveredAt,
          topicKeyword: topic.keyword,
        },
      }),
      prisma.discoveryItem.create({
        data: {
          topicId: otherTopic.id,
          kind: 'quality',
          title: 'AI Agent private result',
          summary: 'Must not leak across users.',
          reason: 'Private owner result.',
          sourceUrls: [`https://example.test/private-${suffix}`],
          canonicalPrimaryUrl: `https://example.test/private-${suffix}`,
          publishedAt: new Date('2026-08-16T07:00:00.000Z'),
          discoveredAt,
          topicKeyword: otherTopic.keyword,
        },
      }),
    ]);
    const monitor = await prisma.trendMonitor.create({
      data: { userId, runStatus: 'succeeded', nextRunAt: snapshotAt },
    });
    const trendRun = await prisma.trendRun.create({
      data: {
        userId,
        monitorId: monitor.id,
        trigger: 'manual',
        status: 'succeeded',
        finishedAt: discoveredAt,
      },
    });
    const radarItem = await prisma.radarItem.create({
      data: {
        userId,
        runId: trendRun.id,
        kind: 'hot',
        title: 'AI Agent trend result',
        summary: 'Owner-scoped trend search result.',
        reason: 'Emerging AI Agent discussion.',
        sourceUrls: [`https://example.test/trend-${suffix}`],
        canonicalPrimaryUrl: `https://example.test/trend-${suffix}`,
        publishedAt: new Date('2026-08-16T06:00:00.000Z'),
        discoveredAt,
      },
    });
    const creator = await prisma.creatorSubscription.create({
      data: {
        userId,
        platform: 'rss',
        accountKey: `https://example.test/creator-${suffix}.xml`,
        displayName: 'AI Agent Author',
        profileUrl: `https://example.test/creator-${suffix}`,
        feedUrl: `https://example.test/creator-${suffix}.xml`,
        runStatus: 'succeeded',
      },
    });
    const creatorItem = await prisma.creatorItem.create({
      data: {
        userId,
        creatorId: creator.id,
        kind: 'quality',
        title: 'AI Agent creator result',
        summary: 'Owner-scoped creator search result.',
        reason: 'Published by a followed AI Agent creator.',
        sourceUrls: [`https://example.test/creator-item-${suffix}`],
        canonicalPrimaryUrl: `https://example.test/creator-item-${suffix}`,
        publishedAt: new Date('2026-08-16T05:00:00.000Z'),
        discoveredAt,
      },
    });

    const filter = {
      origin: 'all' as const,
      since: null,
      snapshotAt,
      limit: 300,
      query: 'AI Agent',
    };
    const [topicMatches, trendMatches] = await Promise.all([
      prisma.$queryRaw<RankedId[]>(buildTopicRankQuery(userId, filter)),
      prisma.$queryRaw<RankedId[]>(buildTrendRankQuery(userId, filter)),
    ]);
    expect(topicMatches.map((match) => match.id)).toContain(topicItem.id);
    expect(topicMatches.map((match) => match.id)).not.toContain(otherTopicItem.id);
    expect(trendMatches.map((match) => match.id)).toContain(radarItem.id);

    const store = new PrismaTopicStore(prisma, undefined, secret);
    await prisma.savedContent.create({
      data: {
        userId,
        contentKey: `https://example.test/topic-${suffix}`,
        savedAt: new Date('2026-08-16T09:00:00.000Z'),
      },
    });
    await prisma.savedContent.create({
      data: {
        userId: otherUserId,
        contentKey: `https://example.test/private-${suffix}`,
        savedAt: new Date('2026-08-16T09:00:00.000Z'),
      },
    });
    const saved = await store.listFeed(userId, {
      origin: 'all',
      since: null,
      query: filter.query,
      reading: 'saved',
      limit: 2,
      windowKey: 'all',
      snapshotAt,
    });
    expect(saved.items).toEqual([
      expect.objectContaining({ id: topicItem.id, readingState: 'saved' }),
    ]);
    await expect(store.setSavedContent(
      userId, `https://example.test/topic-${suffix}`, 'archived',
    )).resolves.toEqual({
      contentKey: `https://example.test/topic-${suffix}`,
      state: 'archived',
    });
    const readingSnapshotAt = new Date(Date.now() + 1_000);
    expect((await store.listFeed(userId, {
      origin: 'all', since: null, reading: 'archived', windowKey: 'all',
      snapshotAt: readingSnapshotAt,
    })).items).toEqual([
      expect.objectContaining({ id: topicItem.id, readingState: 'archived' }),
    ]);
    await expect(store.setSavedContent(
      userId, `https://example.test/topic-${suffix}`, 'saved',
    )).resolves.toEqual({
      contentKey: `https://example.test/topic-${suffix}`,
      state: 'saved',
    });
    await expect(store.setSavedContent(
      userId, `https://example.test/topic-${suffix}`, null,
    )).resolves.toEqual({
      contentKey: `https://example.test/topic-${suffix}`,
      state: null,
    });
    expect((await store.listFeed(userId, {
      origin: 'all', since: null, reading: 'saved', windowKey: 'all',
      snapshotAt: new Date(Date.now() + 1_000),
    })).items).toEqual([]);

    const batchContentKeys = [topicItem.canonicalPrimaryUrl, radarItem.canonicalPrimaryUrl];
    for (const contentKey of batchContentKeys) {
      await expect(store.setSavedContent(userId, contentKey, 'saved')).resolves.toEqual({
        contentKey,
        state: 'saved',
      });
    }
    await expect(store.setSavedContentBatch(userId, batchContentKeys, 'archived'))
      .resolves.toEqual(batchContentKeys.map((contentKey) => ({
        contentKey,
        state: 'archived',
      })));
    const archivedBatch = await prisma.savedContent.findMany({
      where: { userId, contentKey: { in: batchContentKeys }, removedAt: null },
    });
    expect(archivedBatch).toHaveLength(2);
    expect(archivedBatch.every(({ state }) => state === 'archived')).toBe(true);
    expect(new Set(archivedBatch.map(({ savedAt }) => savedAt.toISOString())).size).toBe(1);

    for (const contentKey of batchContentKeys) {
      await store.setSavedContent(userId, contentKey, 'saved');
    }
    await expect(store.setSavedContentBatch(userId, [
      topicItem.canonicalPrimaryUrl,
      otherTopicItem.canonicalPrimaryUrl,
    ], 'archived')).resolves.toBeNull();
    const activeAfterRejectedBatch = await prisma.savedContent.findMany({
      where: { userId, contentKey: { in: batchContentKeys }, removedAt: null },
    });
    expect(activeAfterRejectedBatch).toHaveLength(2);
    expect(activeAfterRejectedBatch.every(({ state }) => state === 'saved')).toBe(true);

    const first = await store.listFeed(userId, {
      origin: 'all',
      since: null,
      query: filter.query,
      limit: 2,
      windowKey: 'all',
      snapshotAt,
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.items.map((item) => item.id)).not.toContain(otherTopicItem.id);

    const inserted = await prisma.discoveryItem.create({
      data: {
        topicId: topic.id,
        kind: 'quality',
        title: 'AI Agent inserted after snapshot',
        summary: 'Must not appear in a continued page.',
        reason: 'Added after the initial page.',
        sourceUrls: [`https://example.test/inserted-${suffix}`],
        canonicalPrimaryUrl: `https://example.test/inserted-${suffix}`,
        publishedAt: new Date('2026-08-16T11:00:00.000Z'),
        discoveredAt: new Date('2026-08-16T13:00:00.000Z'),
        topicKeyword: topic.keyword,
      },
    });
    const second = await store.listFeed(userId, {
      origin: 'all',
      since: null,
      query: filter.query,
      limit: 2,
      windowKey: 'all',
      snapshotAt: new Date('2026-08-17T12:00:00.000Z'),
      cursor: first.nextCursor!,
    });
    const pageIds = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(pageIds)).toEqual(new Set([topicItem.id, radarItem.id, creatorItem.id]));
    expect(pageIds).not.toContain(inserted.id);
    expect(second.nextCursor).toBeNull();

    await expect(store.listFeed(userId, {
      origin: 'all',
      since: null,
      query: filter.query,
      limit: 2,
      windowKey: 'all',
      cursor: first.nextCursor!,
      kind: 'hot',
    })).rejects.toBeInstanceOf(InvalidFeedCursorError);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  }
});
