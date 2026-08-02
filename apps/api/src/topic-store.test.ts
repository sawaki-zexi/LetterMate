import type { DiscoveryCandidate } from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  runSummarySchema,
  trendStatusSchema,
} from '@lettermate/contracts';
import { MemoryTopicStore, PrismaTopicStore } from './topic-store.js';

const candidate = (
  title: string,
  summary: string,
  reason: string,
  slug: string,
  overrides: Partial<DiscoveryCandidate> = {},
): DiscoveryCandidate => ({
  kind: 'quality',
  title,
  summary,
  reason,
  sourceUrls: [`https://example.com/${slug}`],
  publishedAt: '2026-08-02T08:00:00.000Z',
  sourceType: 'web',
  platform: 'Example',
  authorName: null,
  authorHandle: null,
  externalId: null,
  provenanceKind: 'fetched_page',
  ...overrides,
});

describe('topic store multi-source mappings', () => {
  it('maps the latest Prisma discovery run as a strict public summary', async () => {
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
          runs: [{
            id: 'run-2',
            trigger: 'manual',
            status: 'succeeded',
            startedAt: new Date('2026-07-27T09:00:00.000Z'),
            finishedAt: new Date('2026-07-27T09:05:00.000Z'),
            newItemCount: 3,
            connectorSummary: { private: true },
            error: { private: true },
          }],
        }),
      },
    } as unknown as PrismaClient;

    const topic = await new PrismaTopicStore(prisma).findTopic('user-1', 'topic-1');

    expect(topic).toMatchObject({
      nextRunAt: '2026-07-27T20:00:00.000Z',
      scheduleIntervalHours: 12,
      lastRun: {
        id: 'run-2', trigger: 'manual', status: 'succeeded',
        startedAt: '2026-07-27T09:00:00.000Z',
        finishedAt: '2026-07-27T09:05:00.000Z', newItemCount: 3,
      },
    });
    expect(runSummarySchema.parse(topic?.lastRun)).not.toHaveProperty('connectorSummary');
    expect(prisma.topic.findFirst).toHaveBeenCalledWith({
      where: { id: 'topic-1', userId: 'user-1' },
      include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
    });
  });

  it.each([
    ['queued', new Date('2026-07-27T09:05:00.000Z'), 9, null, null],
    ['running', new Date('2026-07-27T09:05:00.000Z'), 9, null, null],
    ['failed', new Date('2026-07-27T09:05:00.000Z'), 9, '2026-07-27T09:05:00.000Z', null],
  ] as const)('normalizes %s Prisma run terminal fields', async (
    status, finishedAt, newItemCount, expectedFinishedAt, expectedNewItemCount,
  ) => {
    const row = {
      id: 'topic-1', userId: 'user-1', keyword: 'Agents', normalizedKeyword: 'agents',
      expandedTerms: [], createdAt: new Date('2026-07-27T08:00:00.000Z'), lastRunAt: null,
      nextRunAt: null, scheduleIntervalHours: 12, productiveRunStreak: 0, emptyRunStreak: 0,
      runStatus: status, lastError: null, activeRunId: null, runLeaseUntil: null,
      manualRefreshPending: false,
      runs: [{
        id: 'run-1', trigger: 'manual', status,
        startedAt: new Date('2026-07-27T09:00:00.000Z'), finishedAt, newItemCount,
      }],
    };
    const prisma = { topic: { findFirst: vi.fn().mockResolvedValue(row) } } as unknown as PrismaClient;

    const topic = await new PrismaTopicStore(prisma).findTopic('user-1', 'topic-1');

    expect(topic?.lastRun).toMatchObject({
      status, finishedAt: expectedFinishedAt, newItemCount: expectedNewItemCount,
    });
    expect(() => runSummarySchema.parse(topic?.lastRun)).not.toThrow();
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
      radarItem: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    const items = await new PrismaTopicStore(prisma).listFeed('user-1', {
      origin: 'all', since: null,
    });

    expect(items[0]).toMatchObject({
      sourceType: 'social',
      platform: 'X',
      authorName: 'Project Team',
      authorHandle: 'project',
      externalId: '100',
      provenanceKind: 'api_record',
      origin: 'topic',
    });
  });

  it('keeps the memory store on the same public contract', async () => {
    const store = new MemoryTopicStore();
    const topic = store.seedTopic('user-1', 'Agents');
    const item = store.seedItem(topic.id, 'quality');

    expect(topic).toMatchObject({ nextRunAt: null, scheduleIntervalHours: 12, lastRun: null });
    expect(item).toMatchObject({
      sourceType: 'web',
      platform: 'Web',
      authorName: null,
      authorHandle: null,
      externalId: null,
      provenanceKind: 'ai_citation',
    });
  });

  it('tracks queued, running, succeeded, and failed memory run summaries with actual inserts', async () => {
    const store = new MemoryTopicStore(() => new Date('2026-07-28T12:00:00.000Z'));
    const topic = await store.createTopic('user-1', 'Agents', 'agents');
    expect(topic.lastRun).toMatchObject({ trigger: 'initial', status: 'queued' });

    await store.startFakeDiscovery('user-1', topic.id);
    expect((await store.findTopic('user-1', topic.id))?.lastRun).toMatchObject({ status: 'running' });
    await store.completeFakeDiscovery('user-1', topic.id, {
      expandedTerms: ['Agents'],
      items: [{
        kind: 'quality', title: 'One', summary: 'Summary', reason: 'Reason',
        sourceUrls: ['https://example.com/one'], publishedAt: null,
        sourceType: 'web', platform: 'Example', authorName: null, authorHandle: null,
        externalId: null, provenanceKind: 'ai_citation',
      }, {
        kind: 'quality', title: 'Duplicate', summary: 'Summary', reason: 'Reason',
        sourceUrls: ['https://example.com/one'], publishedAt: null,
        sourceType: 'web', platform: 'Example', authorName: null, authorHandle: null,
        externalId: null, provenanceKind: 'ai_citation',
      }],
    });
    expect((await store.findTopic('user-1', topic.id))?.lastRun).toMatchObject({
      status: 'succeeded', newItemCount: 1, finishedAt: '2026-07-28T12:00:00.000Z',
    });

    const previousRun = (await store.findTopic('user-1', topic.id))!.lastRun!;
    const queued = await store.queueRefresh('user-1', topic.id);
    expect(queued?.topic).toMatchObject({
      runStatus: 'queued',
      lastRun: { id: previousRun.id, status: 'succeeded' },
    });
    await store.startFakeDiscovery('user-1', topic.id);
    expect((await store.findTopic('user-1', topic.id))?.lastRun).toMatchObject({
      trigger: 'manual', status: 'running',
    });
    expect((await store.findTopic('user-1', topic.id))?.lastRun?.id).not.toBe(previousRun.id);
    await store.failFakeDiscovery('user-1', topic.id, { code: 'FAILED', message: 'Safe failure' });
    expect((await store.findTopic('user-1', topic.id))?.lastRun).toMatchObject({
      trigger: 'manual', status: 'failed', newItemCount: null,
    });
  });

  it('merges user-owned Topic and Radar rows by effective time and stable id', async () => {
    const store = new MemoryTopicStore();
    const topic = store.seedTopic('user-1', 'Agents');
    const topicItem = store.seedItem(topic.id, 'quality', {
      publishedAt: null, discoveredAt: '2026-07-28T10:00:00.000Z',
    });
    const olderRadar = store.seedRadarItem('user-1', 'hot', {
      publishedAt: '2026-07-28T09:00:00.000Z', discoveredAt: '2026-07-28T11:00:00.000Z',
    });
    const newerRadar = store.seedRadarItem('user-1', 'quality', {
      publishedAt: '2026-07-28T10:00:00.000Z', discoveredAt: '2026-07-28T09:00:00.000Z',
    });
    store.seedRadarItem('user-2', 'quality', { publishedAt: '2026-07-28T12:00:00.000Z' });

    const all = await store.listFeed('user-1', {
      origin: 'all', since: new Date('2026-07-28T08:00:00.000Z'),
    });
    expect(all.map(({ id }) => id)).toEqual([newerRadar.id, topicItem.id, olderRadar.id].sort((a, b) => {
      if (a === olderRadar.id) return 1;
      if (b === olderRadar.id) return -1;
      return b.localeCompare(a);
    }));
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: topicItem.id, origin: 'topic', topicId: topic.id }),
      expect.objectContaining({ id: newerRadar.id, origin: 'trend', topicId: null }),
    ]));
    expect(await store.listFeed('user-1', { origin: 'topic', since: null })).toHaveLength(1);
    expect(await store.listFeed('user-1', { origin: 'trend', since: null })).toHaveLength(2);
  });

  it('searches owner articles and ranks title, summary, then recommendation reason', async () => {
    const store = new MemoryTopicStore(() => new Date('2026-08-02T12:00:00.000Z'));
    const topic = store.seedTopic('user-1', 'Agents');
    const otherTopic = store.seedTopic('user-2', 'Private');
    await store.completeFakeDiscovery('user-1', topic.id, {
      expandedTerms: [],
      items: [
        candidate('智能体工程实践', '普通摘要', '普通理由', 'title-match'),
        candidate('摘要匹配文章', '这篇文章讨论智能体工程', '普通理由', 'summary-match'),
        candidate('理由匹配文章', '普通摘要', '推荐阅读智能体工程实践', 'reason-match'),
        candidate('完全无关文章', '普通摘要', '普通理由', 'unmatched'),
      ],
    });
    await store.completeFakeDiscovery('user-2', otherTopic.id, {
      expandedTerms: [],
      items: [candidate('智能体工程私有文章', '普通摘要', '普通理由', 'private-match')],
    });

    const items = await store.listFeed('user-1', {
      origin: 'all', since: null, query: '智能体工程',
    });

    expect(items.map((item) => item.title)).toEqual([
      '智能体工程实践', '摘要匹配文章', '理由匹配文章',
    ]);
  });

  it('combines persisted search with Topic, kind, and effective-time filters', async () => {
    const store = new MemoryTopicStore(() => new Date('2026-08-02T12:00:00.000Z'));
    const selected = store.seedTopic('user-1', 'Selected');
    const excluded = store.seedTopic('user-1', 'Excluded');
    await store.completeFakeDiscovery('user-1', selected.id, {
      expandedTerms: [],
      items: [
        candidate('工程新文章', '摘要', '理由', 'selected-new'),
        candidate('普通新文章', '摘要', '理由', 'selected-unmatched'),
        candidate('工程旧文章', '摘要', '理由', 'selected-old', {
          publishedAt: '2026-07-01T08:00:00.000Z',
        }),
        candidate('工程热点文章', '摘要', '理由', 'selected-hot', { kind: 'hot' }),
      ],
    });
    await store.completeFakeDiscovery('user-1', excluded.id, {
      expandedTerms: [],
      items: [candidate('工程其他主题', '摘要', '理由', 'excluded-topic')],
    });

    const items = await store.listFeed('user-1', {
      origin: 'topic',
      topicId: selected.id,
      kind: 'quality',
      since: new Date('2026-08-01T00:00:00.000Z'),
      query: '工程',
    });

    expect(items.map((item) => item.title)).toEqual(['工程新文章']);
  });

  it('returns only the owner Radar detail and safe trend status', async () => {
    const store = new MemoryTopicStore(() => new Date('2026-07-28T12:00:00.000Z'));
    const radar = store.seedRadarItem('user-1', 'quality');

    expect(await store.findItem('user-2', radar.id)).toBeNull();
    expect(await store.findItem('user-1', radar.id)).toMatchObject({
      id: radar.id, origin: 'trend', topicId: null,
    });
    const initial = await store.getTrendStatus('user-1', 4);
    expect(() => trendStatusSchema.parse(initial)).not.toThrow();
    expect(initial).toEqual({
      runStatus: 'queued', nextRunAt: '2026-07-28T12:00:00.000Z',
      intervalHours: 4, lastError: null, lastRun: null,
    });
  });

  it('queries Prisma Radar detail by both item id and owner', async () => {
    const radar = {
      id: 'radar-1', userId: 'user-1', runId: 'trend-run-1', kind: 'quality',
      title: 'Release', summary: 'Summary', reason: 'Reason',
      sourceUrls: ['https://example.com/release'],
      canonicalPrimaryUrl: 'https://example.com/release', publishedAt: null,
      discoveredAt: new Date('2026-07-28T12:00:00.000Z'),
      updatedAt: new Date('2026-07-28T12:00:00.000Z'), sourceType: 'web',
      platform: 'Example', authorName: null, authorHandle: null, externalId: null,
      provenanceKind: 'fetched_page',
    };
    const prisma = {
      discoveryItem: { findFirst: vi.fn().mockResolvedValue(null) },
      radarItem: {
        findFirst: vi.fn().mockImplementation(({ where }) =>
          where.userId === 'user-1' ? radar : null),
      },
    } as unknown as PrismaClient;
    const store = new PrismaTopicStore(prisma);

    expect(await store.findItem('user-1', 'radar-1')).toMatchObject({
      id: 'radar-1', origin: 'trend', topicId: null,
    });
    expect(await store.findItem('user-2', 'radar-1')).toBeNull();
    expect(prisma.radarItem.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'radar-1', userId: 'user-2' },
    });
  });

  it('provisions and maps only safe Prisma trend status and latest run fields', async () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const prisma = {
      user: { upsert: vi.fn().mockResolvedValue({}) },
      trendMonitor: {
        upsert: vi.fn().mockResolvedValue({
          id: 'monitor-1', userId: 'user-1', runStatus: 'failed', nextRunAt: now,
          intervalHours: 4, activeRunId: null, runLeaseUntil: null,
          manualRefreshPending: false,
          lastError: { code: 'SAFE_FAILURE', message: 'Safe message', secret: 'private' },
          runs: [{
            id: 'trend-run-1', userId: 'user-1', monitorId: 'monitor-1',
            trigger: 'scheduled', status: 'failed', startedAt: now, finishedAt: now,
            candidateCount: 9, acceptedCount: 3, newItemCount: 7,
            error: { private: true },
          }],
        }),
      },
    } as unknown as PrismaClient;

    const status = await new PrismaTopicStore(prisma).getTrendStatus('user-1', 4, now);

    expect(status).toEqual({
      runStatus: 'failed', nextRunAt: now.toISOString(), intervalHours: 4,
      lastError: { code: 'SAFE_FAILURE', message: 'Safe message' },
      lastRun: {
        id: 'trend-run-1', trigger: 'scheduled', status: 'failed',
        startedAt: now.toISOString(), finishedAt: now.toISOString(), newItemCount: null,
      },
    });
    expect(prisma.trendMonitor.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: { userId: 'user-1', intervalHours: 4, nextRunAt: now, runStatus: 'queued' },
      update: {},
      include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
    });
    expect(JSON.stringify(status)).not.toMatch(/secret|candidate|accepted|private/i);
  });

  it('registers one pending refresh without enqueueing while a leased trend run is active', async () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const leaseUntil = new Date('2026-07-28T12:15:00.000Z');
    const running = {
      id: 'monitor-1', userId: 'user-1', runStatus: 'running', nextRunAt: now,
      intervalHours: 4, activeRunId: 'scheduled-run', runLeaseUntil: leaseUntil,
      manualRefreshPending: false, lastError: null,
      runs: [{
        id: 'scheduled-run', userId: 'user-1', monitorId: 'monitor-1',
        trigger: 'scheduled', status: 'running', startedAt: now,
        finishedAt: null, newItemCount: 0,
      }],
    } as const;
    const pending = { ...running, manualRefreshPending: true };
    const prisma = {
      user: { upsert: vi.fn().mockResolvedValue({}) },
      trendMonitor: {
        upsert: vi.fn().mockResolvedValue(running),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(pending),
      },
      trendRun: {
        findUnique: vi.fn().mockResolvedValue({ trigger: 'scheduled', status: 'running' }),
      },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    } as unknown as PrismaClient;

    const result = await new PrismaTopicStore(prisma).queueTrendRefresh('user-1', 4, now);

    expect(result).toMatchObject({
      shouldEnqueue: false,
      status: { runStatus: 'running', lastRun: { id: 'scheduled-run', status: 'running' } },
    });
    expect(prisma.trendMonitor.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'monitor-1', userId: 'user-1', manualRefreshPending: false,
        activeRunId: 'scheduled-run', runLeaseUntil: { gt: now },
        runStatus: { in: ['queued', 'running'] },
      },
      data: { manualRefreshPending: true, lastError: expect.anything() },
    });
  });

  it('does not enqueue while the scheduler holds a queue lease before assigning a run id', async () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const claimed = {
      id: 'monitor-1', userId: 'user-1', runStatus: 'queued', nextRunAt: now,
      intervalHours: 4, activeRunId: null,
      runLeaseUntil: new Date('2026-07-28T12:15:00.000Z'),
      manualRefreshPending: false, lastError: null, runs: [],
    } as const;
    const pending = { ...claimed, manualRefreshPending: true };
    const prisma = {
      user: { upsert: vi.fn().mockResolvedValue({}) },
      trendMonitor: {
        upsert: vi.fn().mockResolvedValue(claimed),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(pending),
      },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    } as unknown as PrismaClient;

    const result = await new PrismaTopicStore(prisma).queueTrendRefresh('user-1', 4, now);

    expect(result).toMatchObject({ shouldEnqueue: false, status: { runStatus: 'queued' } });
    expect(prisma.trendMonitor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ activeRunId: null, runLeaseUntil: { gt: now } }),
    }));
  });

  it('enqueues from the API when the active trend run finishes before pending CAS registration', async () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const running = {
      id: 'monitor-1', userId: 'user-1', runStatus: 'running', nextRunAt: now,
      intervalHours: 4, activeRunId: 'scheduled-run',
      runLeaseUntil: new Date('2026-07-28T12:15:00.000Z'),
      manualRefreshPending: false, lastError: null, runs: [],
    } as const;
    const succeeded = {
      ...running, runStatus: 'succeeded' as const, activeRunId: null,
      runLeaseUntil: null, manualRefreshPending: false,
    };
    let newRunId = '';
    const queued = () => ({
      ...succeeded,
      runStatus: 'queued' as const,
      activeRunId: newRunId,
      runLeaseUntil: new Date('2026-07-28T12:20:00.000Z'),
      runs: [{
        id: newRunId, userId: 'user-1', monitorId: 'monitor-1',
        trigger: 'manual' as const, status: 'queued' as const, startedAt: now,
        finishedAt: null, newItemCount: 0,
      }],
    });
    const prisma = {
      user: { upsert: vi.fn().mockResolvedValue({}) },
      trendMonitor: {
        upsert: vi.fn().mockResolvedValue(running),
        updateMany: vi.fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 }),
        findUniqueOrThrow: vi.fn()
          .mockResolvedValueOnce(succeeded)
          .mockImplementationOnce(async () => queued()),
      },
      trendRun: {
        findUnique: vi.fn().mockResolvedValue({ trigger: 'scheduled', status: 'running' }),
        create: vi.fn(async ({ data }: { data: { id: string } }) => {
          newRunId = data.id;
          return data;
        }),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    } as unknown as PrismaClient;

    const result = await new PrismaTopicStore(prisma).queueTrendRefresh('user-1', 4, now);

    expect(result).toMatchObject({ shouldEnqueue: true, status: { runStatus: 'queued' } });
    expect(prisma.trendMonitor.updateMany).toHaveBeenCalledTimes(2);
  });

  it('creates a distinct manual registration after DB completion while the old job still exists', async () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const oldRun = {
      id: 'manual-old', userId: 'user-1', monitorId: 'monitor-1',
      trigger: 'manual', status: 'succeeded', startedAt: new Date('2026-07-28T11:00:00.000Z'),
      finishedAt: new Date('2026-07-28T11:05:00.000Z'), newItemCount: 0,
    } as const;
    const idle = {
      id: 'monitor-1', userId: 'user-1', runStatus: 'succeeded', nextRunAt: now,
      intervalHours: 4, activeRunId: null, runLeaseUntil: null,
      manualRefreshPending: false, lastError: null, runs: [oldRun],
    } as const;
    let newRunId = '';
    const prisma = {
      user: { upsert: vi.fn().mockResolvedValue({}) },
      trendMonitor: {
        upsert: vi.fn().mockResolvedValue(idle),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn(async () => ({
          ...idle,
          runStatus: 'queued' as const,
          activeRunId: newRunId,
          runLeaseUntil: new Date('2026-07-28T12:20:00.000Z'),
          runs: [{
            ...oldRun,
            id: newRunId,
            trigger: 'manual' as const,
            status: 'queued' as const,
            startedAt: now,
            finishedAt: null,
          }],
        })),
      },
      trendRun: {
        create: vi.fn(async ({ data }: { data: { id: string } }) => {
          newRunId = data.id;
          return data;
        }),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    } as unknown as PrismaClient;

    const result = await new PrismaTopicStore(prisma).queueTrendRefresh('user-1', 4, now);

    expect(result.shouldEnqueue).toBe(true);
    expect(result.registration?.runId).toBe(newRunId);
    expect(newRunId).not.toBe('manual-old');
    expect(result.status.lastRun).toMatchObject({
      id: newRunId, trigger: 'manual', status: 'queued',
    });
    expect(prisma.trendRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: newRunId, userId: 'user-1', monitorId: 'monitor-1',
        trigger: 'manual', status: 'queued', startedAt: now,
      }),
    });
  });

  it('compensates only its unchanged queued trend registration', async () => {
    const registrationUntil = new Date('2026-07-28T12:20:00.000Z');
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      trendMonitor: { updateMany },
      trendRun: { deleteMany },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    } as unknown as PrismaClient;
    const store = new PrismaTopicStore(prisma);
    const registration = {
      monitorId: 'monitor-1', runId: 'manual-new', registrationUntil,
      previousActiveRunId: null, previousRunLeaseUntil: null,
      previousRunStatus: 'succeeded' as const,
      previousLastError: { code: 'PREVIOUS_FAILURE', message: 'Previous safe failure' },
      previousLastRun: null,
    };

    const compensated = await store.compensateTrendRefresh('user-1', registration);

    expect(compensated).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'monitor-1', userId: 'user-1', manualRefreshPending: false,
        runStatus: 'queued', activeRunId: 'manual-new', runLeaseUntil: registrationUntil,
      },
      data: {
        activeRunId: null, runLeaseUntil: null, runStatus: 'succeeded',
        lastError: registration.previousLastError,
      },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'manual-new', userId: 'user-1', monitorId: 'monitor-1',
        trigger: 'manual', status: 'queued',
      },
    });
  });

  it('does not compensate after a worker has claimed the registered trend refresh', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const deleteMany = vi.fn();
    const prisma = {
      trendMonitor: { updateMany }, trendRun: { deleteMany },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    } as unknown as PrismaClient;
    const store = new PrismaTopicStore(prisma);

    const compensated = await store.compensateTrendRefresh('user-1', {
      monitorId: 'monitor-1',
      runId: 'manual-new',
      registrationUntil: new Date('2026-07-28T12:20:00.000Z'),
      previousActiveRunId: null,
      previousRunLeaseUntil: null,
      previousRunStatus: 'succeeded',
      previousLastError: null,
      previousLastRun: null,
    });

    expect(compensated).toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'monitor-1', userId: 'user-1', manualRefreshPending: false,
        runStatus: 'queued', activeRunId: 'manual-new',
        runLeaseUntil: new Date('2026-07-28T12:20:00.000Z'),
      },
      data: {
        activeRunId: null, runLeaseUntil: null,
        runStatus: 'succeeded', lastError: expect.anything(),
      },
    });
    expect(deleteMany).not.toHaveBeenCalled();
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

  it('records one pending manual refresh while an initial or scheduled Topic job is queued', async () => {
    const queued = {
      id: 'topic-queued', userId: 'user-1', keyword: 'Agents', normalizedKeyword: 'agents',
      expandedTerms: [], createdAt: new Date('2026-07-27T08:00:00.000Z'), lastRunAt: null,
      nextRunAt: new Date('2026-07-27T20:00:00.000Z'), scheduleIntervalHours: 12,
      productiveRunStreak: 0, emptyRunStreak: 0, runStatus: 'queued' as const,
      queuedTrigger: 'scheduled' as const, lastError: null, activeRunId: null,
      runLeaseUntil: new Date('2026-07-27T08:15:00.000Z'), manualRefreshPending: false,
    };
    const pending = { ...queued, manualRefreshPending: true };
    const prisma = {
      topic: {
        findFirst: vi.fn().mockResolvedValueOnce(queued).mockResolvedValueOnce(pending),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(prisma)),
    } as unknown as PrismaClient;

    const result = await new PrismaTopicStore(prisma).queueRefresh('user-1', 'topic-queued');

    expect(result).toMatchObject({ shouldEnqueue: false, topic: { runStatus: 'queued' } });
    expect(prisma.topic.updateMany).toHaveBeenCalledWith({
      where: { id: 'topic-queued', userId: 'user-1', runStatus: 'queued', manualRefreshPending: false },
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
