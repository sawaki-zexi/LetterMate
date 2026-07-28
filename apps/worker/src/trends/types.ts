export interface TrendSeedCandidate {
  sourceId: string;
  platform: string;
  externalId: string;
  title: string;
  url: string;
  publishedAt: string | null;
}

export interface TrendWindow {
  windowStart: string;
  windowEnd: string;
  maxCandidates: number;
  requestBudget: number;
  recordRequest?: () => void;
}

export interface TrendSourceResult {
  candidates: TrendSeedCandidate[];
  requestCount: number;
}

export interface TrendSource {
  readonly id: string;
  readonly label: string;
  readonly minimumRequestBudget?: number;
  isEnabled(): boolean;
  collect(window: TrendWindow, signal: AbortSignal): Promise<TrendSourceResult>;
}

export interface TrendSourceFailure {
  sourceId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface TrendCollectionSummary {
  candidates: TrendSeedCandidate[];
  successfulSourceIds: string[];
  skippedSourceIds: string[];
  failures: TrendSourceFailure[];
  requestCount: number;
  requestCounts: Record<string, number>;
}

export class TrendSourceError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    if (!code.trim() || !message.trim()) throw new Error('Trend source error fields must not be blank');
    this.name = 'TrendSourceError';
    this.code = code.trim();
    this.message = message.trim();
    this.retryable = retryable;
  }
}
