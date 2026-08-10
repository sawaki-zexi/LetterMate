import { describe, expect, it } from 'vitest';
import {
  evaluateInterestEffects,
  parseUtcDay,
  utcDayWindow,
} from './interest-effect-evaluation.js';

describe('interest effect evaluation', () => {
  it('uses a half-open UTC day window', () => {
    const window = parseUtcDay('2026-08-10');
    expect(window).toEqual(utcDayWindow(new Date('2026-08-10T23:59:00.000Z')));
    expect(() => parseUtcDay('2026-02-30')).toThrow('date is invalid');
  });

  it('measures feedback, protected subscriptions, exploration, and isolation', () => {
    const window = parseUtcDay('2026-08-10');
    const report = evaluateInterestEffects({
      window,
      decisions: [
        { userId: 'user-a', decisionId: 'd1', contentKey: 'a', lane: 'subscription', isExploration: false, createdAt: new Date('2026-08-10T01:00:00Z') },
        { userId: 'user-a', decisionId: 'd1', contentKey: 'b', lane: 'exploration', isExploration: true, createdAt: new Date('2026-08-10T01:00:00Z') },
        { userId: 'user-a', decisionId: 'd2', contentKey: 'c', lane: 'interest', isExploration: false, createdAt: new Date('2026-08-09T23:59:00Z') },
      ],
      impressions: [
        { userId: 'user-a', decisionId: 'd1', contentKey: 'a', position: 0, shownAt: new Date('2026-08-10T02:00:00Z'), lane: 'subscription', isExploration: false },
        { userId: 'user-a', decisionId: 'd1', contentKey: 'b', position: 1, shownAt: new Date('2026-08-10T02:00:00Z'), lane: 'exploration', isExploration: true },
        { userId: 'user-b', decisionId: 'd1', contentKey: 'a', position: 0, shownAt: new Date('2026-08-10T03:00:00Z'), lane: 'subscription', isExploration: false },
      ],
      feedback: [
        { userId: 'user-a', contentKey: 'a', value: 'interested', occurredAt: new Date('2026-08-10T04:00:00Z') },
        { userId: 'user-a', contentKey: 'unseen', value: 'less', occurredAt: new Date('2026-08-10T04:00:00Z') },
      ],
    });
    expect(report).toMatchObject({
      decisionCount: 1,
      impressionCount: 2,
      uniqueUserCount: 1,
      uniqueContentCount: 2,
      explicitFeedbackCount: 1,
      interestedFeedbackCount: 1,
      lessFeedbackCount: 0,
      feedbackCoverage: 0.5,
      interestedRateAmongFeedback: 1,
      subscriptionCandidateCount: 1,
      subscriptionImpressionCount: 1,
      subscriptionCoverage: 1,
      explorationImpressionCount: 1,
      explorationRate: 0.5,
      crossUserDecisionViolationCount: 1,
    });
  });
});
