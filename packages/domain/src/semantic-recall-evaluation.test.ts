import type { InterestEvent } from '@lettermate/contracts';
import { describe, expect, it } from 'vitest';
import { evaluateSemanticRecall } from './semantic-recall-evaluation.js';

const feedback = (
  id: string,
  contentKey: string,
  occurredAt: string,
  state: 'interested' | 'less',
): InterestEvent => ({
  id, userId: 'user-1', eventType: 'feedback_state', sourceRef: `feedback:${contentKey}`,
  occurredAt, recordedAt: occurredAt, supersededAt: null,
  payload: { schemaVersion: 1, state, contentKey },
});

const tag = (contentKey: string, tagId: string, createdAt = '2026-08-01T00:00:00.000Z') => ({
  contentKey, tagId, confidence: 0.95, createdAt: new Date(createdAt),
});

describe('semantic recall evaluation', () => {
  it('uses only earlier events and separates direct, adjacent, and semantic gaps', () => {
    const train = 'https://example.com/train';
    const direct = 'https://example.com/direct';
    const adjacent = 'https://example.com/adjacent';
    const gap = 'https://example.com/gap';
    const events = [
      feedback('f-train', train, '2026-08-01T10:00:00.000Z', 'interested'),
      feedback('f-direct', direct, '2026-08-02T10:00:00.000Z', 'interested'),
      feedback('f-adjacent', adjacent, '2026-08-03T10:00:00.000Z', 'interested'),
      feedback('f-gap', gap, '2026-08-04T10:00:00.000Z', 'interested'),
      feedback('f-future', gap, '2026-08-05T10:00:00.000Z', 'interested'),
    ];
    const impressions = events.map((event, position) => ({
      userId: 'user-1', decisionUserId: 'user-1',
      contentKey: event.eventType === 'feedback_state' ? event.payload.contentKey : '',
      position, shownAt: new Date(new Date(event.occurredAt).getTime() - 60_000),
    }));
    const report = evaluateSemanticRecall({
      window: {
        start: new Date('2026-08-02T00:00:00.000Z'),
        end: new Date('2026-08-06T00:00:00.000Z'),
      },
      events,
      tags: [{ tagId: 'tag-core', slug: 'core' }, { tagId: 'tag-edge', slug: 'edge' }],
      contentTags: [
        tag(train, 'tag-core'), tag(direct, 'tag-core'),
        tag(adjacent, 'tag-edge'), tag(gap, 'tag-gap'),
      ],
      creatorContent: [],
      impressions,
      adjacencies: [{
        leftTagId: 'tag-core', rightTagId: 'tag-edge',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      }],
      resets: [{ userId: 'user-1', resetAt: new Date('2026-08-10T00:00:00.000Z') }],
      forgottenTags: [],
      subscriptionCandidateCount: 0, subscriptionImpressionCount: 0,
      thresholds: {
        minimumObservationDays: 1, minimumImpressions: 1,
        minimumExplicitFeedback: 1, minimumPositiveFeedback: 1,
        minimumSemanticGapCount: 1, minimumSemanticGapRate: 0.2,
        minimumSemanticGapSplits: 1,
      },
    });

    expect(report).toMatchObject({
      directRecallCount: 1,
      adjacentRecallCount: 1,
      semanticGapCount: 1,
      semanticGapSplitCount: 1,
      dataReady: true,
      semanticRecallRecommended: true,
      decision: 'stable_tag_recall_gap',
    });
    expect(report.splits).toHaveLength(3);
  });

  it('does not misclassify untagged content or cold start as a semantic gap', () => {
    const untagged = 'https://example.com/untagged';
    const report = evaluateSemanticRecall({
      window: {
        start: new Date('2026-08-01T00:00:00.000Z'),
        end: new Date('2026-08-15T00:00:00.000Z'),
      },
      events: [feedback('f-1', untagged, '2026-08-02T10:00:00.000Z', 'interested')],
      tags: [], contentTags: [], creatorContent: [], adjacencies: [], resets: [], forgottenTags: [],
      impressions: [{
        userId: 'user-1', decisionUserId: 'user-1', contentKey: untagged,
        position: 0, shownAt: new Date('2026-08-02T09:00:00.000Z'),
      }],
      subscriptionCandidateCount: 0, subscriptionImpressionCount: 0,
    });

    expect(report).toMatchObject({
      taggedPositiveCount: 0,
      coldStartPositiveCount: 0,
      semanticGapCount: 0,
      semanticRecallRecommended: false,
      decision: 'insufficient_data',
    });
  });

  it('fails the guardrail when an impression references another user decision', () => {
    const contentKey = 'https://example.com/item';
    const report = evaluateSemanticRecall({
      window: {
        start: new Date('2026-08-01T00:00:00.000Z'),
        end: new Date('2026-08-02T00:00:00.000Z'),
      },
      events: [], tags: [], contentTags: [], creatorContent: [], adjacencies: [], resets: [], forgottenTags: [],
      impressions: [{
        userId: 'user-1', decisionUserId: 'user-2', contentKey,
        position: 0, shownAt: new Date('2026-08-01T09:00:00.000Z'),
      }],
      subscriptionCandidateCount: 1, subscriptionImpressionCount: 0,
      thresholds: {
        minimumObservationDays: 0, minimumImpressions: 0,
        minimumExplicitFeedback: 0, minimumPositiveFeedback: 0,
        minimumSemanticGapCount: 0, minimumSemanticGapRate: 0,
        minimumSemanticGapSplits: 0,
      },
    });

    expect(report).toMatchObject({
      dataReady: false,
      decision: 'guardrail_failed',
      crossUserDecisionViolationCount: 1,
      subscriptionCoverage: 0,
    });
  });
});
