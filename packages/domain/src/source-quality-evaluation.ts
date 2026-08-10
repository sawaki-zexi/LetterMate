export interface SourceQualityThresholds {
  minimumObservationCoverage: number;
  minimumWorkerUptime: number;
  repeatedFailureCount: number;
  minimumCandidatesForYield: number;
  minimumAcceptanceRate: number;
  minimumAcceptedForDominance: number;
  maximumSourceDominance: number;
}

export const DEFAULT_SOURCE_QUALITY_THRESHOLDS: SourceQualityThresholds = {
  minimumObservationCoverage: 0.95,
  minimumWorkerUptime: 0.95,
  repeatedFailureCount: 5,
  minimumCandidatesForYield: 20,
  minimumAcceptanceRate: 0.05,
  minimumAcceptedForDominance: 10,
  maximumSourceDominance: 0.90,
};

export interface SourceQualityObservation {
  expectedSampleCount: number;
  observedSampleCount: number;
  healthySampleCount: number;
}

export interface SourceQualityFunnelInput {
  source: string;
  sourceType: string;
  successfulAttempts: number;
  failedAttempts: number;
  failureCodes: Readonly<Record<string, number>>;
  outcomes: Readonly<Record<string, number>>;
}

export type SourceQualityReason =
  | 'REPEATED_FAILURES'
  | 'SUCCESS_WITHOUT_CANDIDATES'
  | 'LOW_ACCEPTANCE_YIELD'
  | 'SINGLE_SOURCE_DOMINANCE';

export interface SourceQualitySourceReport {
  source: string;
  sourceType: string;
  successfulAttempts: number;
  failedAttempts: number;
  failureCodes: Record<string, number>;
  outcomes: Record<string, number>;
  retrievedCount: number;
  acceptedCount: number;
  acceptanceRate: number;
  acceptedShare: number;
  reasons: SourceQualityReason[];
}

export type SourceQualityDecision = 'healthy' | 'review_required' | 'insufficient_data';

export interface SourceQualityEvaluationReport {
  windowStart: string;
  windowEnd: string;
  windowHours: number;
  expectedSampleCount: number;
  observedSampleCount: number;
  healthySampleCount: number;
  observationCoverage: number;
  workerUptime: number;
  sourceCount: number;
  totalAttempts: number;
  totalRetrievedCount: number;
  totalAcceptedCount: number;
  decision: SourceQualityDecision;
  reasons: string[];
  sources: SourceQualitySourceReport[];
}

const ratio = (numerator: number, denominator: number): number => (
  denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6))
);

const assertCount = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
};

const normalizeCounts = (
  values: Readonly<Record<string, number>>,
  name: string,
): Record<string, number> => Object.fromEntries(
  Object.entries(values)
    .map(([key, value]) => {
      if (!key.trim()) throw new Error(`${name} keys must not be blank`);
      assertCount(value, `${name}.${key}`);
      return [key, value] as const;
    })
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Number(value.toFixed(3))]),
);

export function evaluateSourceQuality(input: {
  windowStart: Date;
  windowEnd: Date;
  observation: SourceQualityObservation;
  sources: readonly SourceQualityFunnelInput[];
  thresholds?: SourceQualityThresholds;
}): SourceQualityEvaluationReport {
  const { windowStart, windowEnd, observation } = input;
  const thresholds = input.thresholds ?? DEFAULT_SOURCE_QUALITY_THRESHOLDS;
  if (
    Number.isNaN(windowStart.getTime())
    || Number.isNaN(windowEnd.getTime())
    || windowEnd <= windowStart
  ) throw new Error('source quality window must be valid');
  assertCount(observation.expectedSampleCount, 'expectedSampleCount');
  assertCount(observation.observedSampleCount, 'observedSampleCount');
  assertCount(observation.healthySampleCount, 'healthySampleCount');
  if (observation.healthySampleCount > observation.observedSampleCount) {
    throw new Error('healthySampleCount cannot exceed observedSampleCount');
  }

  const normalizedSources = input.sources.map((source) => {
    if (!source.source.trim() || !source.sourceType.trim()) {
      throw new Error('source identity must not be blank');
    }
    assertCount(source.successfulAttempts, `${source.source}.successfulAttempts`);
    assertCount(source.failedAttempts, `${source.source}.failedAttempts`);
    const outcomes = normalizeCounts(source.outcomes, `${source.source}.outcomes`);
    return {
      ...source,
      source: source.source.trim(),
      sourceType: source.sourceType.trim(),
      failureCodes: normalizeCounts(source.failureCodes, `${source.source}.failureCodes`),
      outcomes,
      retrievedCount: outcomes.retrieved ?? 0,
      acceptedCount: outcomes.accepted ?? 0,
    };
  });
  const totalAcceptedCount = normalizedSources.reduce(
    (total, source) => total + source.acceptedCount,
    0,
  );
  const sources: SourceQualitySourceReport[] = normalizedSources.map((source) => {
    const acceptanceRate = ratio(source.acceptedCount, source.retrievedCount);
    const acceptedShare = ratio(source.acceptedCount, totalAcceptedCount);
    const reasons: SourceQualityReason[] = [];
    if (source.failedAttempts >= thresholds.repeatedFailureCount) reasons.push('REPEATED_FAILURES');
    if (source.successfulAttempts > 0 && source.retrievedCount === 0) {
      reasons.push('SUCCESS_WITHOUT_CANDIDATES');
    }
    if (
      source.retrievedCount >= thresholds.minimumCandidatesForYield
      && acceptanceRate < thresholds.minimumAcceptanceRate
    ) reasons.push('LOW_ACCEPTANCE_YIELD');
    if (
      totalAcceptedCount >= thresholds.minimumAcceptedForDominance
      && acceptedShare > thresholds.maximumSourceDominance
    ) reasons.push('SINGLE_SOURCE_DOMINANCE');
    return {
      source: source.source,
      sourceType: source.sourceType,
      successfulAttempts: Number(source.successfulAttempts.toFixed(3)),
      failedAttempts: Number(source.failedAttempts.toFixed(3)),
      failureCodes: source.failureCodes,
      outcomes: source.outcomes,
      retrievedCount: source.retrievedCount,
      acceptedCount: source.acceptedCount,
      acceptanceRate,
      acceptedShare,
      reasons,
    };
  }).sort((left, right) => left.source.localeCompare(right.source));
  const observationCoverage = ratio(
    observation.observedSampleCount,
    observation.expectedSampleCount,
  );
  const workerUptime = ratio(observation.healthySampleCount, observation.observedSampleCount);
  const totalAttempts = normalizedSources.reduce(
    (total, source) => total + source.successfulAttempts + source.failedAttempts,
    0,
  );
  const reasons: string[] = [];
  if (observationCoverage < thresholds.minimumObservationCoverage) {
    reasons.push('OBSERVATION_COVERAGE_BELOW_MINIMUM');
  }
  if (workerUptime < thresholds.minimumWorkerUptime) reasons.push('WORKER_UPTIME_BELOW_MINIMUM');
  if (totalAttempts === 0) reasons.push('NO_SOURCE_ATTEMPTS');
  const insufficientData = reasons.length > 0;
  const reviewRequired = sources.some((source) => source.reasons.length > 0);
  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowHours: Number(((windowEnd.getTime() - windowStart.getTime()) / 3_600_000).toFixed(3)),
    expectedSampleCount: observation.expectedSampleCount,
    observedSampleCount: observation.observedSampleCount,
    healthySampleCount: observation.healthySampleCount,
    observationCoverage,
    workerUptime,
    sourceCount: sources.length,
    totalAttempts: Number(totalAttempts.toFixed(3)),
    totalRetrievedCount: normalizedSources.reduce((total, source) => total + source.retrievedCount, 0),
    totalAcceptedCount,
    decision: insufficientData ? 'insufficient_data' : reviewRequired ? 'review_required' : 'healthy',
    reasons,
    sources,
  };
}
