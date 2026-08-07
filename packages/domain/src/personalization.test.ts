import type { FeedItem } from '@lettermate/contracts';
import { describe, expect, it } from 'vitest';
import {
  evaluateRecommendationGates,
  interestSlugFromText,
  projectInterestProfile,
  rankShadowSlate,
  rollingTimeSplit,
} from './personalization.js';

const feedItem = (
  contentKey: string,
  overrides: Partial<FeedItem> = {},
): FeedItem => ({
  id: contentKey,
  topicId: null,
  origin: 'trend',
  kind: 'quality',
  title: contentKey,
  summary: '摘要',
  reason: '推荐理由',
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
  ...overrides,
} as FeedItem);

describe('personalization domain module', () => {
  it('projects exact topics, capped creator evidence, and local negative feedback', () => {
    const profile = projectInterestProfile({
      asOf: new Date('2026-08-08T08:00:00.000Z'),
      signals: [
        { tagId: 'gpt', kind: 'topic', occurredAt: '2026-01-01T00:00:00.000Z', confidence: 1 },
        ...Array.from({ length: 10 }, () => ({
          tagId: 'agents', kind: 'creator' as const,
          occurredAt: '2026-08-08T00:00:00.000Z', confidence: 1,
        })),
        { tagId: 'agents', kind: 'interested', occurredAt: '2026-08-01T08:00:00.000Z', confidence: 0.9 },
        { tagId: 'agents', kind: 'less', occurredAt: '2026-08-08T08:00:00.000Z', confidence: 0.9 },
        { tagId: 'broad', kind: 'less', occurredAt: '2026-08-08T08:00:00.000Z', confidence: 0.5 },
      ],
    });
    expect(profile.find((entry) => entry.tagId === 'gpt')).toMatchObject({
      shortScore: 6, longScore: 6, negativeScore: 0,
    });
    expect(profile.find((entry) => entry.tagId === 'agents')).toMatchObject({
      shortScore: 5.25, negativeScore: 4.5,
    });
    expect(profile.some((entry) => entry.tagId === 'broad')).toBe(false);
  });

  it('keeps subscription items protected while ranking matching interests deterministically', () => {
    const candidates = [
      { item: feedItem('https://example.com/unrelated'), tags: [] },
      {
        item: feedItem('https://example.com/interest'),
        tags: [{ tagId: 'agents', confidence: 1 }],
      },
      {
        item: feedItem('https://example.com/followed', {
          origin: 'topic', topicId: 'topic-1',
          origins: [{
            origin: 'topic', topicId: 'topic-1', topicKeyword: 'GPT-5.7',
            topicKeywordActive: true,
          }],
        } as Partial<FeedItem>),
        tags: [],
      },
    ];
    const input = {
      candidates,
      profile: [{
        tagId: 'agents', shortScore: 5, longScore: 3, negativeScore: 0,
        evidenceUpdatedAt: '2026-08-08T08:00:00.000Z',
        sourceKinds: ['interested' as const],
      }],
      asOf: new Date('2026-08-08T08:00:00.000Z'),
    };
    const first = rankShadowSlate(input);
    expect(first.map((item) => item.contentKey)).toEqual([
      'https://example.com/followed',
      'https://example.com/interest',
      'https://example.com/unrelated',
    ]);
    expect(first[0]).toMatchObject({ lane: 'subscription', isExploration: false });
    expect(rankShadowSlate(input)).toEqual(first);
  });

  it('preserves exact version slugs and evaluates chronological gates', () => {
    expect(interestSlugFromText('GPT-5.7')).toBe('gpt-5-7');
    expect(interestSlugFromText('AI Agent')).toBe('ai-agent');
    const values = [new Date('2026-08-03'), new Date('2026-08-01'), new Date('2026-08-02')];
    expect(rollingTimeSplit(values, (value) => value, new Date('2026-08-03'))).toEqual({
      train: [new Date('2026-08-01'), new Date('2026-08-02')],
      test: [new Date('2026-08-03')],
    });
    expect(evaluateRecommendationGates({
      expectedProtectedContentKeys: ['a'], rankedContentKeys: ['a', 'b'],
      crossUserContentCount: 0, exactBoundaryViolationCount: 0,
    })).toMatchObject({ passed: true, missingProtectedCount: 0 });
  });
});
