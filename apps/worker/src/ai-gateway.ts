import type { DiscoveryCandidate, DiscoveryKind, SourceType } from '@lettermate/contracts';
import type { ValidatedSourceCandidate } from '@lettermate/domain';
import type { AiExecutionContext } from './ai-runtime.js';

export const TREND_CLASSIFICATION_MAX_SEEDS = 3;
export const TREND_CLASSIFICATION_MAX_REQUIRED_TERMS = 6;
export const TREND_CLASSIFICATION_MAX_OUTPUT_TOKENS = 4_096;
export const TREND_CLASSIFICATION_MAX_ID_LENGTH = 100;
export const TREND_CLASSIFICATION_MAX_QUERY_LENGTH = 300;
export const TREND_CLASSIFICATION_MAX_TERM_LENGTH = 100;
export const CREATOR_ARCHIVE_LOCALIZATION_MAX_ITEMS = 8;
export const DIGEST_BRIEF_MAX_ITEMS = 10;
export const DIGEST_BRIEF_MAX_SOURCES_PER_ITEM = 20;
export const EVIDENCE_FOLLOWUP_MAX_CONNECTORS = 4;
export const EVIDENCE_FOLLOWUP_MAX_CANDIDATES = 12;
export const EVIDENCE_FOLLOWUP_MAX_REQUIRED_TERMS = 6;
export const EVIDENCE_FOLLOWUP_MAX_QUERY_LENGTH = 300;
export const EVIDENCE_FOLLOWUP_MAX_TERM_LENGTH = 100;
const TREND_CLASSIFICATION_STRUCTURE_UNITS_PER_DECISION = 128;
export const TREND_CLASSIFICATION_WORST_CASE_OUTPUT_UNITS = 32 +
  TREND_CLASSIFICATION_MAX_SEEDS * (
    TREND_CLASSIFICATION_MAX_ID_LENGTH +
    TREND_CLASSIFICATION_MAX_QUERY_LENGTH +
    TREND_CLASSIFICATION_MAX_REQUIRED_TERMS * TREND_CLASSIFICATION_MAX_TERM_LENGTH +
    TREND_CLASSIFICATION_STRUCTURE_UNITS_PER_DECISION
  );

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

export interface CreatorArchiveLocalizationCandidate {
  id: string;
  title: string | null;
  text: string;
  platform: string;
  authorName: string | null;
  authorHandle: string | null;
  publishedAt: string | null;
}

export interface CreatorArchiveLocalization {
  id: string;
  title: string;
  summary: string;
}

export interface DigestBriefCandidate {
  id: string;
  title: string;
  summary: string;
  reason: string;
  platform: string;
  publishedAt: string | null;
  sources: Array<{
    id: string;
    platform: string;
    publishedAt: string | null;
  }>;
}

export interface DigestBriefDraft {
  id: string;
  conclusion: string;
  evidence: string;
  uncertainty: string;
  followUp: string;
  citationIds: string[];
}

export interface TrendSeedClassificationInput {
  id: string;
  title: string;
  platform: string;
  sourceUrl: string;
}

export interface TrendSeedDecision {
  id: string;
  accepted: boolean;
  query: string | null;
  requiredTerms: string[];
}

export type EvidenceGapType =
  | 'missing_body'
  | 'missing_primary_record'
  | 'version_ambiguous'
  | 'date_ambiguous'
  | 'source_conflict';

export interface EvidenceGapCandidate {
  connectorId: string;
  title: string | null;
  content: string | null;
  excerpt: string | null;
  publishedAt: string | null;
  proofKind: 'ai_citation' | 'api_record' | 'feed_entry' | 'fetched_page';
}

export interface EvidenceFollowupDecision {
  gap: EvidenceGapType;
  query: string;
  requiredTerms: string[];
  connectorIds: string[];
}

export interface AiGateway {
  planEvidenceFollowup(input: {
    keyword: string;
    originalQueries: string[];
    allowedConnectorIds: string[];
    successfulConnectorIds: string[];
    failureCodes: Array<{ connectorId: string; code: string }>;
    candidates: EvidenceGapCandidate[];
    execution?: AiExecutionContext;
    signal?: AbortSignal;
  }): Promise<EvidenceFollowupDecision | null>;
  classifyTrendSeeds(input: {
    seeds: TrendSeedClassificationInput[];
    execution?: AiExecutionContext;
    signal?: AbortSignal;
  }): Promise<TrendSeedDecision[]>;
  expandTopic(input: {
    keyword: string;
    execution?: AiExecutionContext;
    signal?: AbortSignal;
  }): Promise<ExpandedTopic>;
  evaluateCandidates(input: {
    keyword: string;
    candidates: QualityAssessmentCandidate[];
    execution?: AiExecutionContext;
    signal?: AbortSignal;
  }): Promise<QualityAssessment[]>;
  composeItems(input: {
    keyword: string;
    candidates: CompositionCandidate[];
    execution?: AiExecutionContext;
    signal?: AbortSignal;
  }): Promise<DiscoveryCandidate[]>;
  localizeCreatorItems(input: {
    creatorName: string;
    candidates: CreatorArchiveLocalizationCandidate[];
    execution?: AiExecutionContext;
    signal?: AbortSignal;
  }): Promise<CreatorArchiveLocalization[]>;
  composeDigestBriefs(input: {
    candidates: DigestBriefCandidate[];
    execution?: AiExecutionContext;
    signal?: AbortSignal;
  }): Promise<DigestBriefDraft[]>;
}

export type AiGatewayErrorCode =
  | 'AI_RATE_LIMITED'
  | 'AI_AUTH_FAILED'
  | 'AI_CREDIT_EXHAUSTED'
  | 'AI_MODEL_UNAVAILABLE'
  | 'AI_UPSTREAM_UNAVAILABLE'
  | 'AI_RESPONSE_INVALID'
  | 'AI_BUDGET_EXCEEDED'
  | 'AI_RUNTIME_POLICY_CHANGED';

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
