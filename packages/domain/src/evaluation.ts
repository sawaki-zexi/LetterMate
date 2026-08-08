import type { DiscoveryCandidate } from '@lettermate/contracts';
import { isChineseContent } from './localization.js';
import { canonicalizeUrl } from './url.js';

export type DiscoveryEvaluationFailure =
  | 'EXPECTED_RECALL_BELOW_TARGET'
  | 'FORBIDDEN_HIT_RATE_ABOVE_LIMIT'
  | 'SOURCE_COVERAGE_BELOW_TARGET'
  | 'CHINESE_COVERAGE_BELOW_TARGET'
  | 'DUPLICATE_RATE_ABOVE_LIMIT';

export interface DiscoveryEvaluationThresholds {
  minimumExpectedRecall: number;
  maximumForbiddenHitRate: number;
  minimumSourceCoverage: number;
  minimumChineseCoverage: number;
  maximumDuplicateRate: number;
}

export interface DiscoveryEvaluationReport {
  caseId: string;
  passed: boolean;
  failures: DiscoveryEvaluationFailure[];
  metrics: {
    itemCount: number;
    expectedRecall: number;
    forbiddenHitRate: number;
    sourceCoverage: number;
    chineseCoverage: number;
    duplicateRate: number;
  };
  missingExpectedUrls: string[];
  matchedForbiddenUrls: string[];
}

export interface DiscoveryEvaluationInput {
  caseId: string;
  items: readonly DiscoveryCandidate[];
  expectedUrls: readonly string[];
  forbiddenUrls?: readonly string[];
  thresholds?: Partial<DiscoveryEvaluationThresholds>;
}

const defaultThresholds: DiscoveryEvaluationThresholds = {
  minimumExpectedRecall: 1,
  maximumForbiddenHitRate: 0,
  minimumSourceCoverage: 1,
  minimumChineseCoverage: 1,
  maximumDuplicateRate: 0,
};

const ratio = (numerator: number, denominator: number, emptyValue: number): number => (
  denominator === 0 ? emptyValue : Number((numerator / denominator).toFixed(6))
);

const canonicalUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return canonicalizeUrl(value);
  } catch {
    return null;
  }
};

const validateThreshold = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
};

export function evaluateDiscoveryOutput(
  input: DiscoveryEvaluationInput,
): DiscoveryEvaluationReport {
  if (!input.caseId.trim()) throw new TypeError('caseId must not be empty');
  const thresholds = { ...defaultThresholds, ...input.thresholds };
  for (const [name, value] of Object.entries(thresholds)) validateThreshold(name, value);

  const expectedUrls = [...new Set(input.expectedUrls.map(canonicalizeUrl))];
  const forbiddenUrls = [...new Set((input.forbiddenUrls ?? []).map(canonicalizeUrl))];
  const primaryUrls = input.items.map((item) => canonicalUrl(item.sourceUrls[0] ?? ''));
  const allUrls = input.items.flatMap((item) => item.sourceUrls.map(canonicalUrl))
    .filter((url): url is string => url !== null);
  const matchedUrls = new Set(primaryUrls.filter((url): url is string => url !== null));
  const allMatchedUrls = new Set(allUrls);
  const missingExpectedUrls = expectedUrls.filter((url) => !matchedUrls.has(url));
  const matchedForbiddenUrls = forbiddenUrls.filter((url) => allMatchedUrls.has(url));
  const sourceCoveredCount = input.items.filter((item) => (
    item.sourceUrls.length > 0 && item.sourceUrls.every((url) => canonicalUrl(url) !== null)
  )).length;
  const chineseCoveredCount = input.items.filter((item) => (
    isChineseContent(item.title) && isChineseContent(item.summary) && isChineseContent(item.reason)
  )).length;
  const validPrimaryUrls = primaryUrls.filter((url): url is string => url !== null);
  const duplicateCount = validPrimaryUrls.length - new Set(validPrimaryUrls).size;
  const metrics = {
    itemCount: input.items.length,
    expectedRecall: ratio(expectedUrls.length - missingExpectedUrls.length, expectedUrls.length, 1),
    forbiddenHitRate: ratio(matchedForbiddenUrls.length, forbiddenUrls.length, 0),
    sourceCoverage: ratio(sourceCoveredCount, input.items.length, 1),
    chineseCoverage: ratio(chineseCoveredCount, input.items.length, 1),
    duplicateRate: ratio(duplicateCount, input.items.length, 0),
  };
  const failures: DiscoveryEvaluationFailure[] = [];
  if (metrics.expectedRecall < thresholds.minimumExpectedRecall) {
    failures.push('EXPECTED_RECALL_BELOW_TARGET');
  }
  if (metrics.forbiddenHitRate > thresholds.maximumForbiddenHitRate) {
    failures.push('FORBIDDEN_HIT_RATE_ABOVE_LIMIT');
  }
  if (metrics.sourceCoverage < thresholds.minimumSourceCoverage) {
    failures.push('SOURCE_COVERAGE_BELOW_TARGET');
  }
  if (metrics.chineseCoverage < thresholds.minimumChineseCoverage) {
    failures.push('CHINESE_COVERAGE_BELOW_TARGET');
  }
  if (metrics.duplicateRate > thresholds.maximumDuplicateRate) {
    failures.push('DUPLICATE_RATE_ABOVE_LIMIT');
  }
  return {
    caseId: input.caseId,
    passed: failures.length === 0,
    failures,
    metrics,
    missingExpectedUrls,
    matchedForbiddenUrls,
  };
}
