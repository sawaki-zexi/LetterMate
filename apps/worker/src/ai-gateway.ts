import type { DiscoveryCandidate, DiscoveryKind, SourceType } from '@lettermate/contracts';
import type { ValidatedSourceCandidate } from '@lettermate/domain';

export interface ExpandedTopic {
  terms: string[];
  searchQueries: string[];
}

export interface QualityAssessmentCandidate {
  id: string;
  url: string;
  sourceType: SourceType;
  platform: string;
  title: string | null;
  text: string;
  authorName: string | null;
  authorHandle: string | null;
  publishedAt: string | null;
}

export interface QualityAssessment {
  id: string;
  accepted: boolean;
  kind: DiscoveryKind | null;
  reason: string;
  claimSupport: 'supported' | 'unsupported' | 'conflicting';
}

export interface CompositionCandidate {
  candidate: ValidatedSourceCandidate;
  assessment: QualityAssessment;
}

export interface AiGateway {
  expandTopic(input: { keyword: string; signal?: AbortSignal }): Promise<ExpandedTopic>;
  evaluateCandidates(input: {
    keyword: string;
    candidates: QualityAssessmentCandidate[];
    signal?: AbortSignal;
  }): Promise<QualityAssessment[]>;
  composeItems(input: {
    keyword: string;
    candidates: CompositionCandidate[];
    signal?: AbortSignal;
  }): Promise<DiscoveryCandidate[]>;
}

export type AiGatewayErrorCode =
  | 'AI_RATE_LIMITED'
  | 'AI_AUTH_FAILED'
  | 'AI_MODEL_UNAVAILABLE'
  | 'AI_UPSTREAM_UNAVAILABLE'
  | 'AI_RESPONSE_INVALID';

export class AiGatewayError extends Error {
  readonly retryAfterMs?: number;

  constructor(
    public readonly code: AiGatewayErrorCode,
    message: string,
    public readonly retryable: boolean,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiGatewayError';
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}
