import type { FeedItem, InterestEvent } from '@lettermate/contracts';
import { describe, expect, it } from 'vitest';
import {
  MemoryPersonalizationMemory,
  type MemoryPersonalizationFacts,
} from './personalization-memory.js';

const eventBase = {
  recordedAt: '2026-08-08T08:00:00.000Z',
  supersededAt: null,
};

const feedbackEvent = (userId: string, id: string): InterestEvent => ({
  ...eventBase,
  id,
  userId,
  eventType: 'feedback_state',
  sourceRef: 'https://example.com/evidence',
  payload: {
    schemaVersion: 1,
    state: 'interested',
    contentKey: 'https://example.com/evidence',
  },
  occurredAt: '2026-08-08T08:00:00.000Z',
});

const topicEvent = (userId: string, id: string): InterestEvent => ({
  ...eventBase,
  id,
  userId,
  eventType: 'topic_state',
  sourceRef: 'topic-agents',
  payload: {
    schemaVersion: 1,
    state: 'active',
    topicId: 'topic-agents',
    keyword: 'Agents',
    normalizedKeyword: 'agents',
  },
  occurredAt: '2026-08-08T08:00:00.000Z',
});

const candidate = (contentKey: string): FeedItem => ({
  id: contentKey,
  topicId: null,
  origin: 'trend',
  kind: 'quality',
  title: '候选内容',
  summary: '候选摘要',
  reason: '候选理由',
  sourceUrls: [contentKey],
  publishedAt: '2026-08-07T08:00:00.000Z',
  discoveredAt: '2026-08-07T08:00:00.000Z',
  sourceType: 'web',
  platform: 'Web',
  authorName: null,
  authorHandle: null,
  externalId: null,
  provenanceKind: 'fetched_page',
  contentKey,
  feedback: null,
  origins: [{ origin: 'trend' }],
});

describe('personalization memory adapters', () => {
  it('produces a stable shadow receipt without leaking another user signals', async () => {
    const facts: MemoryPersonalizationFacts = {
      events: [feedbackEvent('user-1', 'event-1'), feedbackEvent('user-2', 'event-2')],
      tags: [
        {
          tagId: 'tag-agents', slug: 'agents', confidence: 0.95,
          displayName: 'Agents', kind: 'topic',
          contentKey: 'https://example.com/evidence',
          createdAt: '2026-08-08T08:00:00.000Z',
        },
        {
          tagId: 'tag-agents', slug: 'agents', confidence: 0.95,
          displayName: 'Agents', kind: 'topic',
          contentKey: 'https://example.com/matching',
          createdAt: '2026-08-08T08:00:00.000Z',
        },
      ],
      creatorContent: [],
      settings: {},
      forgottenTagIds: {},
    };
    const memory = new MemoryPersonalizationMemory(() => facts);
    const input = {
      userId: 'user-1',
      surface: 'feed' as const,
      candidates: [
        candidate('https://example.com/unrelated'),
        candidate('https://example.com/matching'),
      ],
      asOf: new Date('2026-08-08T08:30:00.000Z'),
    };
    const first = await memory.select(input);
    expect(first.ranked.map((item) => item.contentKey)).toEqual([
      'https://example.com/matching',
      'https://example.com/unrelated',
    ]);
    expect(await memory.select(input)).toEqual(first);

    facts.events = [feedbackEvent('user-2', 'event-2')];
    const withoutOwnedSignal = await memory.select(input);
    expect(withoutOwnedSignal.profileVersion).not.toBe(first.profileVersion);
  });

  it('pauses ranking, resets behavioral history, and keeps forgotten themes suppressed', async () => {
    const facts: MemoryPersonalizationFacts = {
      events: [
        topicEvent('user-1', 'topic-event-1'),
        feedbackEvent('user-1', 'feedback-event-1'),
        feedbackEvent('user-2', 'feedback-event-2'),
      ],
      tags: [
        {
          tagId: 'tag-agents', slug: 'agents', displayName: 'Agents', kind: 'topic',
          confidence: 1, contentKey: 'https://example.com/evidence',
          createdAt: '2026-08-08T08:00:00.000Z',
        },
        {
          tagId: 'tag-agents', slug: 'agents', displayName: 'Agents', kind: 'topic',
          confidence: 1, contentKey: 'https://example.com/matching',
          createdAt: '2026-08-08T08:00:00.000Z',
        },
      ],
      creatorContent: [],
      settings: {},
      forgottenTagIds: {},
    };
    const memory = new MemoryPersonalizationMemory(
      () => facts,
      () => new Date('2026-08-09T08:00:00.000Z'),
    );
    const input = {
      userId: 'user-1', surface: 'feed' as const,
      candidates: [
        candidate('https://example.com/unrelated'),
        candidate('https://example.com/matching'),
      ],
      asOf: new Date('2026-08-09T08:00:00.000Z'),
    };

    expect((await memory.select(input)).ranked[0]?.contentKey)
      .toBe('https://example.com/matching');
    await memory.control('user-1', { type: 'set_enabled', enabled: false });
    expect((await memory.select(input)).ranked.map((item) => item.contentKey)).toEqual(
      input.candidates.map((item) => item.contentKey),
    );

    await memory.control('user-1', { type: 'clear_history' });
    const afterReset = await memory.inspect('user-1');
    expect(afterReset.longTerm[0]).toMatchObject({
      id: 'tag-agents', sources: ['keyword'],
    });

    await memory.control('user-1', { type: 'forget_tag', tagId: 'tag-agents' });
    expect(await memory.inspect('user-1')).toMatchObject({ recent: [], longTerm: [], reduced: [] });
    await memory.control('user-1', { type: 'clear_history' });
    expect(await memory.inspect('user-1')).toMatchObject({ recent: [], longTerm: [], reduced: [] });
    expect((await memory.inspect('user-2')).recent[0]).toMatchObject({ id: 'tag-agents' });
  });
});
