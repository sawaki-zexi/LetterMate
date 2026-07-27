import type { SourceType } from '@lettermate/contracts';
import type { SourceCandidate } from '@lettermate/domain';

export interface SourceQueryPlan {
  keyword: string;
  expandedTerms: string[];
  queries: string[];
  sourceTypes: SourceType[];
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
}

export interface ConnectorFailure {
  connectorId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface ConnectorSearchSummary {
  candidates: SourceCandidate[];
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
