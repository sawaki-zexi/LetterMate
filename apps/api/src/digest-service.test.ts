import type { FeedItem, InterestEvent } from '@lettermate/contracts';
import { INTEREST_ADJACENCY_VERSION } from '@lettermate/domain';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  DefaultDigestService,
  MemoryDigestPreferenceStore,
  PrismaDigestPreferenceStore,
  type MemoryDigestFacts,
} from './digest-service.js';
import {
  MemoryPersonalizationMemory,
  type MemoryPersonalizationFacts,
} from './personalization-memory.js';
import type { TopicStore } from './topic-store.js';

const candidate = (index: number, discoveredAt: string): FeedItem => ({
  id: `item-${index}`,
  topicId: null,
  origin: 'trend',
  kind: 'quality',
  title: `技术内容 ${index}`,
  summary: `中文摘要 ${index}`,
  reason: `推荐理由 ${index}`,
  sourceUrls: [`https://example.com/${index}`],
  publishedAt: null,
  discoveredAt,
  sourceType: 'web',
  platform: 'Example',
  authorName: null,
  authorHandle: null,
  externalId: `${index}`,
  provenanceKind: 'fetched_page',
  contentKey: `https://example.com/${index}`,
  feedback: null,
  origins: [{ origin: 'trend' }],
});

describe('daily digest preview service', () => {
  it('uses the success boundary, excludes adjacent exploration, and caps the preview at ten', async () => {
    const boundary = '2026-08-07T08:00:00.000Z';
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(
      index,
      index === 11 ? boundary : `2026-08-08T${String(index).padStart(2, '0')}:00:00.000Z`,
    ));
    const topicEvent: InterestEvent = {
      id: 'topic-event', userId: 'user-a', eventType: 'topic_state',
      sourceRef: 'topic-core', occurredAt: boundary, recordedAt: boundary, supersededAt: null,
      payload: {
        schemaVersion: 1, state: 'active', topicId: 'topic-core',
        keyword: 'Core', normalizedKeyword: 'core',
      },
    };
    const personalizationFacts: MemoryPersonalizationFacts = {
      events: [topicEvent],
      tags: [
        {
          tagId: 'tag-core', slug: 'core', displayName: 'Core', kind: 'topic',
          confidence: 1, contentKey: 'topic://core', createdAt: boundary,
        },
        {
          tagId: 'tag-edge', slug: 'edge', displayName: 'Edge', kind: 'topic',
          confidence: 0.9, contentKey: candidates[0]!.contentKey, createdAt: boundary,
        },
      ],
      creatorContent: [], settings: {}, forgottenTagIds: {},
      adjacencies: [{
        leftTagId: 'tag-core', rightTagId: 'tag-edge',
        relationVersion: INTEREST_ADJACENCY_VERSION,
      }],
    };
    const digestFacts: MemoryDigestFacts = {
      preferences: {}, completedBoundaries: { 'user-a': boundary },
    };
    const listFeed = vi.fn().mockResolvedValue(candidates);
    const service = new DefaultDigestService(
      new MemoryDigestPreferenceStore(() => digestFacts),
      { listFeed } as unknown as TopicStore,
      new MemoryPersonalizationMemory(() => personalizationFacts),
      () => new Date('2026-08-08T12:00:00.000Z'),
    );

    const preview = await service.preview('user-a');

    expect(listFeed).toHaveBeenCalledWith('user-a', {
      origin: 'all', since: new Date(boundary),
    });
    expect(preview.items).toHaveLength(10);
    expect(preview.items.some((item) => item.contentKey === candidates[0]!.contentKey)).toBe(false);
    expect(preview.items.some((item) => item.contentKey === candidates[11]!.contentKey)).toBe(false);
    expect(digestFacts.completedBoundaries?.['user-a']).toBe(boundary);
  });

  it('persists safe defaults and updates without accepting a recipient address', async () => {
    const facts: MemoryDigestFacts = { preferences: {} };
    const preferences = new MemoryDigestPreferenceStore(() => facts);

    await expect(preferences.get('user-a')).resolves.toEqual({
      enabled: false, localTime: '08:00', timezone: 'Asia/Shanghai',
    });
    await expect(preferences.update('user-a', {
      enabled: true, localTime: '09:15', timezone: 'Asia/Tokyo',
    })).resolves.toEqual({
      enabled: true, localTime: '09:15', timezone: 'Asia/Tokyo',
    });
    expect(facts.preferences['user-b']).toBeUndefined();
  });

  it('returns only the safe recent run summary for the owned user', async () => {
    const recentRun = {
      status: 'succeeded' as const,
      scheduledLocalDate: '2026-08-08',
      finishedAt: '2026-08-08T00:01:00.000Z',
      itemCount: 4,
    };
    const preferences = new MemoryDigestPreferenceStore(() => ({
      preferences: {}, recentRuns: { 'user-a': recentRun },
    }));

    await expect(preferences.recentRun('user-a')).resolves.toEqual(recentRun);
    await expect(preferences.recentRun('user-b')).resolves.toBeNull();
  });

  it('reports delivery capability and the next local scheduled date safely', async () => {
    const facts: MemoryDigestFacts = {
      preferences: {
        'user-a': { enabled: true, localTime: '09:30', timezone: 'Asia/Shanghai' },
      },
      recentRuns: {
        'user-a': {
          status: 'succeeded', scheduledLocalDate: '2026-08-08',
          finishedAt: '2026-08-08T01:31:00.000Z', itemCount: 2,
        },
      },
    };
    const service = new DefaultDigestService(
      new MemoryDigestPreferenceStore(() => facts),
      { listFeed: vi.fn() } as unknown as TopicStore,
      new MemoryPersonalizationMemory(() => ({
        events: [], tags: [], creatorContent: [], settings: {}, forgottenTagIds: {},
      })),
      () => new Date('2026-08-08T02:00:00.000Z'),
      true,
    );

    await expect(service.status('user-a')).resolves.toEqual({
      deliveryCapability: 'configured',
      nextLocalSend: {
        localDate: '2026-08-09', localTime: '09:30', timezone: 'Asia/Shanghai',
      },
      recentRun: facts.recentRuns?.['user-a'],
    });

    const unconfigured = new DefaultDigestService(
      new MemoryDigestPreferenceStore(() => facts),
      { listFeed: vi.fn() } as unknown as TopicStore,
      new MemoryPersonalizationMemory(() => ({
        events: [], tags: [], creatorContent: [], settings: {}, forgottenTagIds: {},
      })),
    );
    await expect(unconfigured.status('user-a')).resolves.toMatchObject({
      deliveryCapability: 'not_configured', nextLocalSend: null,
    });
  });

  it('advances the preview boundary only for succeeded or skipped runs', async () => {
    const boundary = new Date('2026-08-08T00:00:00.000Z');
    const findFirst = vi.fn().mockResolvedValue({ windowEnd: boundary });
    const prisma = { digestRun: { findFirst } } as unknown as PrismaClient;

    await expect(new PrismaDigestPreferenceStore(prisma).lastCompletedBoundary('user-a'))
      .resolves.toEqual(boundary);
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-a', status: { in: ['succeeded', 'skipped'] } },
      select: { windowEnd: true },
      orderBy: [{ windowEnd: 'desc' }, { id: 'desc' }],
    });
  });
});
