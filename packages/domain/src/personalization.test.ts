import type { FeedItem } from '@lettermate/contracts';
import { describe, expect, it } from 'vitest';
import {
  applyExplorationEligibility,
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

  it('directly demotes less feedback even when the content has no interest tags', () => {
    const ranked = rankShadowSlate({
      candidates: [
        {
          item: feedItem('https://example.com/a', { feedback: 'less' }),
          tags: [],
        },
        { item: feedItem('https://example.com/b'), tags: [] },
      ],
      profile: [],
      asOf: new Date('2026-08-08T08:00:00.000Z'),
    });

    expect(ranked.map((item) => item.contentKey)).toEqual([
      'https://example.com/b',
      'https://example.com/a',
    ]);
    expect(ranked[1]?.reasonCodes).toContain('REDUCED_INTEREST');
  });

  it('marks at most ten percent of an ordinary Feed as adjacent exploration', () => {
    const profile = [{
      tagId: 'core', shortScore: 5, longScore: 3, negativeScore: 0,
      evidenceUpdatedAt: '2026-08-08T08:00:00.000Z', sourceKinds: ['interested' as const],
    }];
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      item: feedItem(`https://example.com/${index}`),
      tags: [{ tagId: index === 0 ? 'adjacent' : `unrelated-${index}`, confidence: 0.9 }],
    }));
    const eligible = applyExplorationEligibility({
      candidates,
      profile,
      adjacencies: [{ leftTagId: 'adjacent', rightTagId: 'core' }],
      forgottenTagIds: [],
      surface: 'feed',
    });
    const first = rankShadowSlate({
      candidates: eligible, profile, asOf: new Date('2026-08-08T08:00:00.000Z'),
    });

    expect(first.filter((item) => item.isExploration)).toEqual([
      expect.objectContaining({
        contentKey: 'https://example.com/0',
        lane: 'exploration',
        reasonCodes: ['ADJACENT_EXPLORATION'],
      }),
    ]);
    expect(rankShadowSlate({
      candidates: eligible, profile, asOf: new Date('2026-08-08T08:00:00.000Z'),
    })).toEqual(first);
    expect(rankShadowSlate({
      candidates: eligible.slice(0, 9), profile, asOf: new Date('2026-08-08T08:00:00.000Z'),
    }).some((item) => item.isExploration)).toBe(false);
  });

  it('excludes subscriptions, direct interests, forgotten and negative content from exploration', () => {
    const profile = [
      {
        tagId: 'core', shortScore: 5, longScore: 3, negativeScore: 0,
        evidenceUpdatedAt: '2026-08-08T08:00:00.000Z', sourceKinds: ['interested' as const],
      },
      {
        tagId: 'negative', shortScore: 0, longScore: 0, negativeScore: 4,
        evidenceUpdatedAt: '2026-08-08T08:00:00.000Z', sourceKinds: ['less' as const],
      },
    ];
    const adjacent = (contentKey: string, tagId: string, overrides: Partial<FeedItem> = {}) => ({
      item: feedItem(contentKey, overrides),
      tags: [{ tagId, confidence: 0.9 }],
    });
    const candidates = [
      adjacent('eligible', 'edge'),
      adjacent('direct', 'core'),
      adjacent('forgotten', 'forgotten'),
      adjacent('negative', 'negative'),
      adjacent('less', 'edge', { feedback: 'less' }),
      adjacent('topic', 'edge', {
        origin: 'topic', topicId: 'topic-1',
        origins: [{
          origin: 'topic', topicId: 'topic-1', topicKeyword: 'Core', topicKeywordActive: true,
        }],
      } as Partial<FeedItem>),
      adjacent('creator', 'edge', {
        origin: 'creator',
        origins: [{
          origin: 'creator', creatorId: 'creator-1', creatorName: 'Creator',
          platform: 'X', contentType: 'original',
        }],
      } as Partial<FeedItem>),
    ];
    const adjacencies = [
      { leftTagId: 'core', rightTagId: 'edge' },
      { leftTagId: 'core', rightTagId: 'forgotten' },
      { leftTagId: 'core', rightTagId: 'negative' },
    ];

    expect(applyExplorationEligibility({
      candidates, profile, adjacencies, forgottenTagIds: ['forgotten'], surface: 'feed',
    }).map((candidate) => candidate.explorationEligible)).toEqual([
      true, false, false, false, false, false, false,
    ]);
    expect(applyExplorationEligibility({
      candidates, profile, adjacencies, forgottenTagIds: [], surface: 'digest',
    }).every((candidate) => !candidate.explorationEligible)).toBe(true);
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
