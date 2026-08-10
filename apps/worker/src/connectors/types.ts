import type { SourceType } from '@lettermate/contracts';
import type { KeywordProfile, SourceCandidate, ValidatedSourceCandidate } from '@lettermate/domain';
import type { KeywordPolicy } from '../keyword-policy.js';

export interface SourceQueryPlan {
  keyword: string;
  matchPolicy: KeywordPolicy;
  keywordProfile?: KeywordProfile;
  expandedTerms: string[];
  queries: string[];
  sourceTypes: SourceType[];
  connectorIds?: string[];
  windowStart: string;
  windowEnd: string;
  maxCandidates: number;
}

export interface SourceConnector {
  readonly id: string;
  readonly label: string;
  readonly sourceType: SourceType;
  isEnabled(): boolean;
  supports(plan: SourceQueryPlan): boolean;
  search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult>;
}

export interface ConnectorResult {
  candidates: SourceCandidate[];
  requestCount?: number;
  degradations?: ConnectorDegradation[];
  identity?: {
    displayName: string;
    profileUrl: string;
    handle: string | null;
  };
}

/** Safe, provider-agnostic information about a source stream that was skipped. */
export interface ConnectorDegradation {
  source: string;
  code: string;
  retryable: boolean;
}

export interface ConnectorFailure {
  connectorId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface ConnectorSearchSummary {
  candidates: ValidatedSourceCandidate[];
  successfulConnectorIds: string[];
  skippedConnectorIds: string[];
  failures: ConnectorFailure[];
}

export class ConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    if (code.trim().length === 0 || message.trim().length === 0) {
      throw new Error('Connector error code and message must not be blank');
    }
    this.name = 'ConnectorError';
    this.code = code.trim();
    this.message = message.trim();
    this.retryable = retryable;
  }
}
