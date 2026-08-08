import type { FeedItem } from '@lettermate/contracts';

export const INTEREST_TAXONOMY_VERSION = '2026-08-08-v1';
export const INTEREST_EXTRACTOR_VERSION = 'openrouter-theme-v1';
export const INTEREST_PROFILE_POLICY_VERSION = 'interest-profile-v1';
export const INTEREST_SHADOW_RANKING_VERSION = 'interest-shadow-v1';
export const INTEREST_RULES_RANKING_VERSION = 'interest-rules-v2';
export const INTEREST_DISABLED_RANKING_VERSION = 'personalization-off-v1';
export const INTEREST_ADJACENCY_VERSION = 'qualified-content-cooccurrence-v1';

const DAY_MS = 24 * 60 * 60 * 1_000;

export type InterestSignalKind = 'topic' | 'creator' | 'interested' | 'less';

export interface InterestSignal {
  tagId: string;
  kind: InterestSignalKind;
  occurredAt: string;
  confidence: number;
}

export interface InterestProfileEntry {
  tagId: string;
  shortScore: number;
  longScore: number;
  negativeScore: number;
  evidenceUpdatedAt: string;
  sourceKinds: InterestSignalKind[];
}

export interface CandidateInterestTag {
  tagId: string;
  confidence: number;
}

export interface ShadowCandidate {
  item: FeedItem;
  tags: CandidateInterestTag[];
  explorationEligible?: boolean;
}

export interface InterestTagAdjacency {
  leftTagId: string;
  rightTagId: string;
}

export type RecommendationLane = 'subscription' | 'interest' | 'trend' | 'exploration';
export type RecommendationReasonCode =
  | 'FOLLOWED_TOPIC'
  | 'FOLLOWED_CREATOR'
  | 'RELATED_INTEREST'
  | 'REDUCED_INTEREST'
  | 'RECENT_HOT_TOPIC'
  | 'ADJACENT_EXPLORATION';

export interface ShadowRankedItem {
  contentKey: string;
  position: number;
  lane: RecommendationLane;
  isExploration: boolean;
  reasonCodes: RecommendationReasonCode[];
  score: number;
}

const decay = (ageDays: number, halfLifeDays: number): number => (
  2 ** (-Math.max(0, ageDays) / halfLifeDays)
);

const rounded = (value: number): number => Number(value.toFixed(6));

const isSubscriptionCandidate = (candidate: ShadowCandidate): boolean => (
  candidate.item.origins.some((origin) => (
    origin.origin === 'creator'
    || origin.origin === 'topic' && origin.topicKeywordActive
  ))
);

const hasPositiveInterest = (profile: InterestProfileEntry): boolean => (
  profile.shortScore + profile.longScore > profile.negativeScore
  && profile.shortScore + profile.longScore > 0
);

export function applyExplorationEligibility(input: {
  candidates: readonly ShadowCandidate[];
  profile: readonly InterestProfileEntry[];
  adjacencies: readonly InterestTagAdjacency[];
  forgottenTagIds: readonly string[];
  surface: 'feed' | 'digest';
}): ShadowCandidate[] {
  const positiveTagIds = new Set(
    input.profile.filter(hasPositiveInterest).map((entry) => entry.tagId),
  );
  const negativeTagIds = new Set(
    input.profile.filter((entry) => entry.negativeScore > 0).map((entry) => entry.tagId),
  );
  const forgottenTagIds = new Set(input.forgottenTagIds);
  const adjacentToPositive = new Set<string>();
  for (const relation of input.adjacencies) {
    if (positiveTagIds.has(relation.leftTagId)) adjacentToPositive.add(relation.rightTagId);
    if (positiveTagIds.has(relation.rightTagId)) adjacentToPositive.add(relation.leftTagId);
  }
  return input.candidates.map((candidate) => {
    const tagIds = candidate.tags.map((tag) => tag.tagId);
    const explorationEligible = input.surface === 'feed'
      && candidate.item.feedback !== 'less'
      && !isSubscriptionCandidate(candidate)
      && !tagIds.some((tagId) => forgottenTagIds.has(tagId))
      && !tagIds.some((tagId) => negativeTagIds.has(tagId))
      && !tagIds.some((tagId) => positiveTagIds.has(tagId))
      && tagIds.some((tagId) => adjacentToPositive.has(tagId));
    return { ...candidate, explorationEligible };
  });
}

export function interestSlugFromText(value: string): string | null {
  const slug = value.normalize('NFKC').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

export function projectInterestProfile(input: {
  signals: readonly InterestSignal[];
  asOf: Date;
}): InterestProfileEntry[] {
  const grouped = new Map<string, InterestSignal[]>();
  for (const signal of input.signals) {
    if (!signal.tagId || !Number.isFinite(signal.confidence)) continue;
    const values = grouped.get(signal.tagId) ?? [];
    values.push({ ...signal, confidence: Math.min(1, Math.max(0, signal.confidence)) });
    grouped.set(signal.tagId, values);
  }

  return [...grouped.entries()].map(([tagId, signals]) => {
    let shortScore = 0;
    let longScore = 0;
    let negativeScore = 0;
    let creatorShort = 0;
    let creatorLong = 0;
    let evidenceUpdatedAt = signals[0]!.occurredAt;
    for (const signal of signals) {
      const occurredAt = new Date(signal.occurredAt);
      if (Number.isNaN(occurredAt.getTime()) || occurredAt > input.asOf) continue;
      const ageDays = (input.asOf.getTime() - occurredAt.getTime()) / DAY_MS;
      evidenceUpdatedAt = signal.occurredAt > evidenceUpdatedAt
        ? signal.occurredAt
        : evidenceUpdatedAt;
      if (signal.kind === 'topic') {
        shortScore += 6 * signal.confidence;
        longScore += 6 * signal.confidence;
      } else if (signal.kind === 'creator') {
        creatorShort += 1.5 * signal.confidence * decay(ageDays, 7);
        creatorLong += signal.confidence * decay(ageDays, 90);
      } else if (signal.kind === 'interested' && signal.confidence >= 0.65) {
        shortScore += 5 * signal.confidence * decay(ageDays, 7);
        longScore += 3 * signal.confidence * decay(ageDays, 90);
      } else if (signal.kind === 'less' && signal.confidence >= 0.8) {
        negativeScore += 5 * signal.confidence * decay(ageDays, 30);
      }
    }
    shortScore += Math.min(3, creatorShort);
    longScore += Math.min(2, creatorLong);
    return {
      tagId,
      shortScore: rounded(shortScore),
      longScore: rounded(longScore),
      negativeScore: rounded(negativeScore),
      evidenceUpdatedAt,
      sourceKinds: [...new Set(signals.map((signal) => signal.kind))].sort(),
    };
  }).filter((entry) => (
    entry.shortScore > 0 || entry.longScore > 0 || entry.negativeScore > 0
  )).sort((left, right) => left.tagId.localeCompare(right.tagId));
}

const effectiveTime = (item: FeedItem): number => new Date(
  item.publishedAt ?? item.discoveredAt,
).getTime();

function candidateScore(
  candidate: ShadowCandidate,
  profiles: ReadonlyMap<string, InterestProfileEntry>,
  asOf: Date,
): { score: number; reasons: RecommendationReasonCode[]; lane: RecommendationLane } {
  const followedTopic = candidate.item.origins.some((origin) => (
    origin.origin === 'topic' && origin.topicKeywordActive
  ));
  const followedCreator = candidate.item.origins.some((origin) => origin.origin === 'creator');
  const trend = candidate.item.origins.some((origin) => origin.origin === 'trend');
  let positive = 0;
  let negative = 0;
  for (const tag of candidate.tags) {
    const profile = profiles.get(tag.tagId);
    if (!profile) continue;
    positive += tag.confidence * (
      2 * Math.log1p(profile.shortScore) + Math.log1p(profile.longScore)
    );
    negative += tag.confidence * 2 * Math.log1p(profile.negativeScore);
  }
  const ageDays = Math.max(0, (asOf.getTime() - effectiveTime(candidate.item)) / DAY_MS);
  const subscription = followedTopic ? 20 : followedCreator ? 16 : 0;
  const freshness = 2 * decay(ageDays, 3);
  const hot = candidate.item.kind === 'hot' ? 1 : 0;
  const multiOrigin = Math.min(2, Math.max(0, candidate.item.origins.length - 1)) * 0.5;
  const score = subscription + positive - negative + freshness + hot + multiOrigin;
  const reasons: RecommendationReasonCode[] = [];
  if (followedTopic) reasons.push('FOLLOWED_TOPIC');
  if (followedCreator) reasons.push('FOLLOWED_CREATOR');
  if (positive > 0) reasons.push('RELATED_INTEREST');
  if (negative > 0) reasons.push('REDUCED_INTEREST');
  if (trend && candidate.item.kind === 'hot') reasons.push('RECENT_HOT_TOPIC');
  const lane: RecommendationLane = followedTopic || followedCreator
    ? 'subscription'
    : positive > negative ? 'interest' : 'trend';
  return { score: rounded(score), reasons, lane };
}

const primaryTag = (candidate: ShadowCandidate): string | null => (
  [...candidate.tags].sort((left, right) => (
    right.confidence - left.confidence || left.tagId.localeCompare(right.tagId)
  ))[0]?.tagId ?? null
);

function diversify(
  ranked: Array<ShadowCandidate & ReturnType<typeof candidateScore>>,
): Array<ShadowCandidate & ReturnType<typeof candidateScore>> {
  const remaining = [...ranked];
  const result: typeof remaining = [];
  while (remaining.length > 0) {
    const recent = result.slice(-2);
    const selectedIndex = remaining.findIndex((candidate) => {
      const tag = primaryTag(candidate);
      return !recent.every((item) => (
        tag !== null && primaryTag(item) === tag
        || item.item.platform === candidate.item.platform
        || item.item.authorHandle !== null
          && item.item.authorHandle === candidate.item.authorHandle
      ));
    });
    result.push(remaining.splice(selectedIndex < 0 ? 0 : selectedIndex, 1)[0]!);
  }
  return result;
}

export function rankShadowSlate(input: {
  candidates: readonly ShadowCandidate[];
  profile: readonly InterestProfileEntry[];
  asOf: Date;
}): ShadowRankedItem[] {
  const profiles = new Map(input.profile.map((entry) => [entry.tagId, entry]));
  const scored = input.candidates.map((candidate) => ({
    ...candidate,
    ...candidateScore(candidate, profiles, input.asOf),
  })).sort((left, right) => (
    right.score - left.score
    || effectiveTime(right.item) - effectiveTime(left.item)
    || left.item.contentKey.localeCompare(right.item.contentKey)
  ));
  const diversified = diversify(scored);
  const explorationLimit = Math.floor(diversified.length * 0.1);
  let explorationCount = 0;
  return diversified.map((candidate, index) => {
    const isExploration = Boolean(candidate.explorationEligible)
      && explorationCount < explorationLimit
      && candidate.lane !== 'subscription';
    if (isExploration) explorationCount += 1;
    return {
      contentKey: candidate.item.contentKey,
      position: index,
      lane: isExploration ? 'exploration' : candidate.lane,
      isExploration,
      reasonCodes: isExploration
        ? [...candidate.reasons, 'ADJACENT_EXPLORATION']
        : candidate.reasons,
      score: candidate.score,
    };
  });
}

export function rollingTimeSplit<T>(
  values: readonly T[],
  occurredAt: (value: T) => Date,
  cutoff: Date,
): { train: T[]; test: T[] } {
  const sorted = [...values].sort((left, right) => (
    occurredAt(left).getTime() - occurredAt(right).getTime()
  ));
  return {
    train: sorted.filter((value) => occurredAt(value) < cutoff),
    test: sorted.filter((value) => occurredAt(value) >= cutoff),
  };
}

export function evaluateRecommendationGates(input: {
  expectedProtectedContentKeys: readonly string[];
  rankedContentKeys: readonly string[];
  crossUserContentCount: number;
  exactBoundaryViolationCount: number;
}) {
  const ranked = new Set(input.rankedContentKeys);
  const missingProtectedCount = input.expectedProtectedContentKeys
    .filter((contentKey) => !ranked.has(contentKey)).length;
  return {
    missingProtectedCount,
    crossUserContentCount: input.crossUserContentCount,
    exactBoundaryViolationCount: input.exactBoundaryViolationCount,
    passed: missingProtectedCount === 0
      && input.crossUserContentCount === 0
      && input.exactBoundaryViolationCount === 0,
  };
}
