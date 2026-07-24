import type { DiscoveryResult } from '@lettermate/contracts';

export interface ExpandedTopic {
  terms: string[];
  searchQueries: string[];
}

export interface AiGateway {
  expandTopic(input: { keyword: string }): Promise<ExpandedTopic>;
  discover(input: {
    keyword: string;
    expandedTerms: string[];
    lookbackDays: number;
    now: string;
  }): Promise<DiscoveryResult>;
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
