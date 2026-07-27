import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { MemoryTopicStore, PrismaTopicStore } from './topic-store.js';

describe('topic store multi-source mappings', () => {
  it('maps Prisma topic schedule fields', async () => {
    const prisma = {
      topic: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'topic-1',
          userId: 'user-1',
          keyword: 'Agents',
          normalizedKeyword: 'agents',
          expandedTerms: [],
          createdAt: new Date('2026-07-27T08:00:00.000Z'),
          lastRunAt: null,
          nextRunAt: new Date('2026-07-27T20:00:00.000Z'),
          scheduleIntervalHours: 12,
          productiveRunStreak: 0,
          emptyRunStreak: 0,
          runStatus: 'queued',
          lastError: null,
        }),
      },
    } as unknown as PrismaClient;

    const topic = await new PrismaTopicStore(prisma).findTopic('user-1', 'topic-1');

    expect(topic).toMatchObject({
      nextRunAt: '2026-07-27T20:00:00.000Z',
      scheduleIntervalHours: 12,
    });
  });

  it('maps Prisma discovery source metadata', async () => {
    const prisma = {
      discoveryItem: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'item-1',
          topicId: 'topic-1',
          kind: 'hot',
          title: 'Release announcement',
          summary: 'Chinese summary',
          reason: 'First-party announcement',
          sourceUrls: ['https://x.com/project/status/100'],
          canonicalPrimaryUrl: 'https://x.com/project/status/100',
          publishedAt: new Date('2026-07-27T08:00:00.000Z'),
          discoveredAt: new Date('2026-07-27T09:00:00.000Z'),
          updatedAt: new Date('2026-07-27T09:00:00.000Z'),
          sourceType: 'social',
          platform: 'X',
          authorName: 'Project Team',
          authorHandle: 'project',
          externalId: '100',
          provenanceKind: 'api_record',
        }]),
      },
    } as unknown as PrismaClient;

    const items = await new PrismaTopicStore(prisma).listFeed('user-1', {});

    expect(items[0]).toMatchObject({
      sourceType: 'social',
      platform: 'X',
      authorName: 'Project Team',
      authorHandle: 'project',
      externalId: '100',
      provenanceKind: 'api_record',
    });
  });

  it('keeps the memory store on the same public contract', async () => {
    const store = new MemoryTopicStore();
    const topic = store.seedTopic('user-1', 'Agents');
    const item = store.seedItem(topic.id, 'quality');

    expect(topic).toMatchObject({ nextRunAt: null, scheduleIntervalHours: 12 });
    expect(item).toMatchObject({
      sourceType: 'web',
      platform: 'Web',
      authorName: null,
      authorHandle: null,
      externalId: null,
      provenanceKind: 'ai_citation',
    });
  });

  it('queues only one pending manual refresh without changing a running topic state', async () => {
    const running = {
      id: 'topic-1', userId: 'user-1', keyword: 'Agents', normalizedKeyword: 'agents',
      expandedTerms: [], createdAt: new Date('2026-07-27T08:00:00.000Z'), lastRunAt: null,
      nextRunAt: new Date('2026-07-27T20:00:00.000Z'), scheduleIntervalHours: 12,
      productiveRunStreak: 0, emptyRunStreak: 0, runStatus: 'running', lastError: null,
      activeRunId: 'run-active', runLeaseUntil: new Date('2026-07-27T08:15:00.000Z'),
      manualRefreshPending: false,
    } as const;
    const pending = { ...running, manualRefreshPending: true };
    const prisma = {
      topic: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(running)
          .mockResolvedValueOnce(pending)
          .mockResolvedValueOnce(pending)
          .mockResolvedValueOnce(pending),
        updateMany: vi.fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    } as unknown as PrismaClient;
    const store = new PrismaTopicStore(prisma);

    const first = await store.queueRefresh('user-1', 'topic-1');
    const second = await store.queueRefresh('user-1', 'topic-1');

    expect(first).toMatchObject({ shouldEnqueue: true, topic: { runStatus: 'running' } });
    expect(second).toMatchObject({ shouldEnqueue: false, topic: { runStatus: 'running' } });
    expect((prisma.topic.updateMany as ReturnType<typeof vi.fn>)).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'topic-1', userId: 'user-1', runStatus: 'running', manualRefreshPending: false,
      },
      data: { manualRefreshPending: true, lastError: expect.anything() },
    });
  });

  it('does not lose a refresh when the active run finishes during pending registration', async () => {
    const running = {
      id: 'topic-1', userId: 'user-1', keyword: 'Agents', normalizedKeyword: 'agents',
      expandedTerms: [], createdAt: new Date('2026-07-27T08:00:00.000Z'), lastRunAt: null,
      nextRunAt: null, scheduleIntervalHours: 12, productiveRunStreak: 0, emptyRunStreak: 0,
      runStatus: 'running', lastError: null, activeRunId: 'run-active',
      runLeaseUntil: new Date('2026-07-27T08:15:00.000Z'), manualRefreshPending: false,
    } as const;
    const succeeded = { ...running, runStatus: 'succeeded' as const, activeRunId: null, runLeaseUntil: null };
    const queued = { ...succeeded, runStatus: 'queued' as const };
    const prisma = {
      topic: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(running)
          .mockResolvedValueOnce(succeeded)
          .mockResolvedValueOnce(queued),
        updateMany: vi.fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    } as unknown as PrismaClient;

    const result = await new PrismaTopicStore(prisma).queueRefresh('user-1', 'topic-1');

    expect(result).toMatchObject({ shouldEnqueue: true, topic: { runStatus: 'queued' } });
  });
});
