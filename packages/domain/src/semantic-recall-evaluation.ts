import type { InterestEvent } from '@lettermate/contracts';
import {
  interestSlugFromText,
  projectInterestProfile,
  type InterestSignal,
} from './personalization.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface SemanticRecallWindow {
  start: Date;
  end: Date;
}

export interface SemanticRecallTag {
  tagId: string;
  slug: string;
}

export interface SemanticRecallContentTag {
  contentKey: string;
  tagId: string;
  confidence: number;
  createdAt: Date;
}

export interface SemanticRecallCreatorContent {
  userId: string;
  creatorId: string;
  contentKey: string;
  discoveredAt: Date;
}

export interface SemanticRecallImpression {
  userId: string;
  decisionUserId: string;
  contentKey: string;
  position: number;
  shownAt: Date;
}

export interface SemanticRecallAdjacency {
  leftTagId: string;
  rightTagId: string;
  createdAt: Date;
}

export interface SemanticRecallReset {
  userId: string;
  resetAt: Date;
}

export interface SemanticRecallForgottenTag {
  userId: string;
  tagId: string;
  createdAt: Date;
}

export interface SemanticRecallThresholds {
  minimumObservationDays: number;
  minimumImpressions: number;
  minimumExplicitFeedback: number;
  minimumPositiveFeedback: number;
  minimumSemanticGapCount: number;
  minimumSemanticGapRate: number;
  minimumSemanticGapSplits: number;
}

export interface SemanticRecallSplitReport {
  testDate: string;
  labelCount: number;
  positiveCount: number;
  negativeCount: number;
  directRecallCount: number;
  adjacentRecallCount: number;
  semanticGapCount: number;
}

export type SemanticRecallDecision =
  | 'insufficient_data'
  | 'guardrail_failed'
  | 'no_stable_gap'
  | 'stable_tag_recall_gap';

export interface SemanticRecallEvaluationReport {
  windowStart: string;
  windowEnd: string;
  observationDays: number;
  impressionCount: number;
  explicitFeedbackCount: number;
  positiveFeedbackCount: number;
  negativeFeedbackCount: number;
  taggedPositiveCount: number;
  coldStartPositiveCount: number;
  directRecallCount: number;
  adjacentRecallCount: number;
  semanticGapCount: number;
  semanticGapSplitCount: number;
  directRecallRate: number;
  directOrAdjacentRecallRate: number;
  semanticGapRate: number;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
  subscriptionCoverage: number;
  crossUserDecisionViolationCount: number;
  dataReady: boolean;
  semanticRecallRecommended: boolean;
  decision: SemanticRecallDecision;
  reasons: string[];
  splits: SemanticRecallSplitReport[];
}

const defaultThresholds: SemanticRecallThresholds = {
  minimumObservationDays: 14,
  minimumImpressions: 200,
  minimumExplicitFeedback: 30,
  minimumPositiveFeedback: 10,
  minimumSemanticGapCount: 5,
  minimumSemanticGapRate: 0.15,
  minimumSemanticGapSplits: 3,
};

const ratio = (numerator: number, denominator: number, emptyValue = 0): number => (
  denominator === 0 ? emptyValue : Number((numerator / denominator).toFixed(6))
);

const utcDate = (value: Date): string => value.toISOString().slice(0, 10);

const latestEventsBefore = (
  events: readonly InterestEvent[],
  userId: string,
  before: Date,
): InterestEvent[] => {
  const latest = new Map<string, InterestEvent>();
  for (const event of events) {
    if (event.userId !== userId || new Date(event.occurredAt) >= before) continue;
    const key = `${event.eventType}\u0000${event.sourceRef}`;
    const previous = latest.get(key);
    if (!previous || event.occurredAt > previous.occurredAt
      || event.occurredAt === previous.occurredAt && event.id > previous.id) {
      latest.set(key, event);
    }
  }
  return [...latest.values()];
};

const positiveTagIds = (signals: readonly InterestSignal[], asOf: Date): Set<string> => new Set(
  projectInterestProfile({ signals, asOf })
    .filter((profile) => (
      profile.shortScore + profile.longScore > 0
      && profile.shortScore + profile.longScore > profile.negativeScore
    ))
    .map(({ tagId }) => tagId),
);

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

export function evaluateSemanticRecall(input: {
  window: SemanticRecallWindow;
  events: readonly InterestEvent[];
  tags: readonly SemanticRecallTag[];
  contentTags: readonly SemanticRecallContentTag[];
  creatorContent: readonly SemanticRecallCreatorContent[];
  impressions: readonly SemanticRecallImpression[];
  adjacencies: readonly SemanticRecallAdjacency[];
  resets: readonly SemanticRecallReset[];
  forgottenTags: readonly SemanticRecallForgottenTag[];
  subscriptionCandidateCount: number;
  subscriptionImpressionCount: number;
  thresholds?: Partial<SemanticRecallThresholds>;
}): SemanticRecallEvaluationReport {
  if (!(input.window.start < input.window.end)) throw new RangeError('window must be non-empty');
  const thresholds = { ...defaultThresholds, ...input.thresholds };
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must not be negative`);
  }
  if (thresholds.minimumSemanticGapRate > 1) {
    throw new RangeError('minimumSemanticGapRate must not exceed 1');
  }
  const tagBySlug = new Map(input.tags.map((tag) => [tag.slug, tag.tagId]));
  const contentTagsByKey = new Map<string, SemanticRecallContentTag[]>();
  for (const tag of input.contentTags) {
    const values = contentTagsByKey.get(tag.contentKey) ?? [];
    values.push(tag);
    contentTagsByKey.set(tag.contentKey, values);
  }
  const resetsByUser = new Map(input.resets.map((reset) => [reset.userId, reset.resetAt]));
  const validImpressions = input.impressions.filter((impression) => (
    impression.userId === impression.decisionUserId
  ));
  const windowImpressions = input.impressions.filter((impression) => (
    impression.shownAt >= input.window.start && impression.shownAt < input.window.end
  ));
  const crossUserDecisionViolationCount = windowImpressions.filter((impression) => (
    impression.userId !== impression.decisionUserId
  )).length;
  const impressionsByUserContent = new Map<string, SemanticRecallImpression[]>();
  for (const impression of validImpressions) {
    const key = `${impression.userId}\u0000${impression.contentKey}`;
    const values = impressionsByUserContent.get(key) ?? [];
    values.push(impression);
    impressionsByUserContent.set(key, values);
  }
  const orderedFeedback = input.events.filter((event) => (
    event.eventType === 'feedback_state'
    && (event.payload.state === 'interested' || event.payload.state === 'less')
    && new Date(event.occurredAt) < input.window.end
  )).sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)
  ));
  const seenFeedbackContent = new Set<string>();
  const labels = orderedFeedback.filter((event) => {
    if (event.eventType !== 'feedback_state') return false;
    const key = `${event.userId}\u0000${event.payload.contentKey}`;
    if (seenFeedbackContent.has(key)) return false;
    seenFeedbackContent.add(key);
    const occurredAt = new Date(event.occurredAt);
    return occurredAt >= input.window.start && occurredAt < input.window.end;
  });
  const evaluated = labels.flatMap((label) => {
    if (label.eventType !== 'feedback_state'
      || (label.payload.state !== 'interested' && label.payload.state !== 'less')) return [];
    const occurredAt = new Date(label.occurredAt);
    const impression = (impressionsByUserContent.get(
      `${label.userId}\u0000${label.payload.contentKey}`,
    ) ?? []).filter((candidate) => candidate.shownAt <= occurredAt)
      .sort((left, right) => right.shownAt.getTime() - left.shownAt.getTime())[0];
    if (!impression) return [];
    const storedResetAt = resetsByUser.get(label.userId);
    const resetAt = storedResetAt && storedResetAt < occurredAt ? storedResetAt : undefined;
    const targetTags = (contentTagsByKey.get(label.payload.contentKey) ?? [])
      .filter((tag) => tag.createdAt <= occurredAt);
    const historical = latestEventsBefore(input.events, label.userId, occurredAt);
    const activeCreators = new Set(historical.flatMap((event) => (
      event.eventType === 'creator_state' && event.payload.state === 'active'
        ? [event.payload.creatorId] : []
    )));
    const signals: InterestSignal[] = [];
    for (const event of historical) {
      if (event.eventType === 'topic_state' && event.payload.state === 'active') {
        const slug = interestSlugFromText(event.payload.normalizedKeyword);
        const tagId = slug ? tagBySlug.get(slug) : undefined;
        if (tagId) signals.push({
          tagId, kind: 'topic', occurredAt: event.occurredAt, confidence: 1,
        });
      }
      if (
        event.eventType === 'feedback_state'
        && event.payload.contentKey !== label.payload.contentKey
        && (event.payload.state === 'interested' || event.payload.state === 'less')
        && (!resetAt || new Date(event.occurredAt) >= resetAt)
      ) {
        for (const tag of contentTagsByKey.get(event.payload.contentKey) ?? []) {
          if (tag.createdAt <= occurredAt) signals.push({
            tagId: tag.tagId, kind: event.payload.state,
            occurredAt: event.occurredAt, confidence: tag.confidence,
          });
        }
      }
    }
    for (const content of input.creatorContent) {
      if (
        content.userId !== label.userId
        || !activeCreators.has(content.creatorId)
        || content.discoveredAt >= occurredAt
        || resetAt && content.discoveredAt < resetAt
      ) continue;
      for (const tag of contentTagsByKey.get(content.contentKey) ?? []) {
        if (tag.createdAt <= occurredAt) signals.push({
          tagId: tag.tagId, kind: 'creator',
          occurredAt: content.discoveredAt.toISOString(), confidence: tag.confidence,
        });
      }
    }
    const forgotten = new Set(input.forgottenTags.filter((tag) => (
      tag.userId === label.userId && tag.createdAt <= occurredAt
    )).map(({ tagId }) => tagId));
    const profileTags = positiveTagIds(signals, occurredAt);
    for (const tagId of forgotten) profileTags.delete(tagId);
    const targetTagIds = new Set(targetTags.map(({ tagId }) => tagId));
    const direct = [...targetTagIds].some((tagId) => profileTags.has(tagId));
    const adjacentIds = new Set<string>();
    for (const relation of input.adjacencies) {
      if (relation.createdAt > occurredAt) continue;
      if (profileTags.has(relation.leftTagId)) adjacentIds.add(relation.rightTagId);
      if (profileTags.has(relation.rightTagId)) adjacentIds.add(relation.leftTagId);
    }
    const adjacent = !direct && [...targetTagIds].some((tagId) => adjacentIds.has(tagId));
    const positive = label.payload.state === 'interested';
    const tagged = targetTagIds.size > 0;
    const coldStart = profileTags.size === 0;
    const semanticGap = positive && tagged && !coldStart && !direct && !adjacent;
    return [{
      date: utcDate(occurredAt), positive, tagged, coldStart, direct, adjacent, semanticGap,
      position: impression.position,
    }];
  });
  const splitMap = new Map<string, SemanticRecallSplitReport>();
  for (const label of evaluated) {
    const split = splitMap.get(label.date) ?? {
      testDate: label.date, labelCount: 0, positiveCount: 0, negativeCount: 0,
      directRecallCount: 0, adjacentRecallCount: 0, semanticGapCount: 0,
    };
    split.labelCount += 1;
    split.positiveCount += label.positive ? 1 : 0;
    split.negativeCount += label.positive ? 0 : 1;
    split.directRecallCount += label.positive && label.direct ? 1 : 0;
    split.adjacentRecallCount += label.positive && label.adjacent ? 1 : 0;
    split.semanticGapCount += label.semanticGap ? 1 : 0;
    splitMap.set(label.date, split);
  }
  const positives = evaluated.filter(({ positive }) => positive);
  const taggedPositives = positives.filter(({ tagged }) => tagged);
  const evaluablePositives = taggedPositives.filter(({ coldStart }) => !coldStart);
  const directRecallCount = evaluablePositives.filter(({ direct }) => direct).length;
  const adjacentRecallCount = evaluablePositives.filter(({ adjacent }) => adjacent).length;
  const semanticGapCount = evaluablePositives.filter(({ semanticGap }) => semanticGap).length;
  const semanticGapSplitCount = [...splitMap.values()]
    .filter(({ semanticGapCount: count }) => count > 0).length;
  const inWindowImpressions = windowImpressions.filter((impression) => (
    impression.userId === impression.decisionUserId
  )).length;
  const observationDays = Math.ceil(
    (input.window.end.getTime() - input.window.start.getTime()) / DAY_MS,
  );
  const subscriptionCoverage = ratio(
    input.subscriptionImpressionCount,
    input.subscriptionCandidateCount,
    1,
  );
  const dataReasons = [
    ...(observationDays < thresholds.minimumObservationDays ? ['OBSERVATION_DAYS_BELOW_MINIMUM'] : []),
    ...(inWindowImpressions < thresholds.minimumImpressions ? ['IMPRESSION_COUNT_BELOW_MINIMUM'] : []),
    ...(evaluated.length < thresholds.minimumExplicitFeedback ? ['FEEDBACK_COUNT_BELOW_MINIMUM'] : []),
    ...(positives.length < thresholds.minimumPositiveFeedback ? ['POSITIVE_FEEDBACK_BELOW_MINIMUM'] : []),
  ];
  const guardrailReasons = [
    ...(crossUserDecisionViolationCount > 0 ? ['CROSS_USER_DECISION_VIOLATION'] : []),
    ...(subscriptionCoverage < 1 ? ['SUBSCRIPTION_COVERAGE_BELOW_ONE'] : []),
  ];
  const semanticGapRate = ratio(semanticGapCount, evaluablePositives.length);
  const gapReasons = [
    ...(semanticGapCount < thresholds.minimumSemanticGapCount ? ['SEMANTIC_GAP_COUNT_BELOW_MINIMUM'] : []),
    ...(semanticGapRate < thresholds.minimumSemanticGapRate ? ['SEMANTIC_GAP_RATE_BELOW_MINIMUM'] : []),
    ...(semanticGapSplitCount < thresholds.minimumSemanticGapSplits ? ['SEMANTIC_GAP_SPLITS_BELOW_MINIMUM'] : []),
  ];
  const dataReady = dataReasons.length === 0 && guardrailReasons.length === 0;
  const semanticRecallRecommended = dataReady && gapReasons.length === 0;
  const decision: SemanticRecallDecision = dataReasons.length > 0
    ? 'insufficient_data'
    : guardrailReasons.length > 0
      ? 'guardrail_failed'
      : gapReasons.length > 0
        ? 'no_stable_gap'
        : 'stable_tag_recall_gap';
  const reciprocalRanks = positives.map(({ position }) => position < 10 ? 1 / (position + 1) : 0);
  const discountedGains = positives.map(({ position }) => (
    position < 10 ? 1 / Math.log2(position + 2) : 0
  ));
  return {
    windowStart: input.window.start.toISOString(),
    windowEnd: input.window.end.toISOString(),
    observationDays,
    impressionCount: inWindowImpressions,
    explicitFeedbackCount: evaluated.length,
    positiveFeedbackCount: positives.length,
    negativeFeedbackCount: evaluated.length - positives.length,
    taggedPositiveCount: taggedPositives.length,
    coldStartPositiveCount: taggedPositives.filter(({ coldStart }) => coldStart).length,
    directRecallCount,
    adjacentRecallCount,
    semanticGapCount,
    semanticGapSplitCount,
    directRecallRate: ratio(directRecallCount, evaluablePositives.length),
    directOrAdjacentRecallRate: ratio(
      directRecallCount + adjacentRecallCount,
      evaluablePositives.length,
    ),
    semanticGapRate,
    recallAt10: ratio(positives.filter(({ position }) => position < 10).length, positives.length),
    mrrAt10: ratio(sum(reciprocalRanks), positives.length),
    ndcgAt10: ratio(sum(discountedGains), positives.length),
    subscriptionCoverage,
    crossUserDecisionViolationCount,
    dataReady,
    semanticRecallRecommended,
    decision,
    reasons: dataReasons.length > 0
      ? dataReasons
      : guardrailReasons.length > 0
        ? guardrailReasons
        : gapReasons,
    splits: [...splitMap.values()].sort((left, right) => left.testDate.localeCompare(right.testDate)),
  };
}
