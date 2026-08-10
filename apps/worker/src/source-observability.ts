import type { SourceType } from '@lettermate/contracts';
import type { ValidatedSourceCandidate } from '@lettermate/domain';

export type SourceAttemptResult = 'success' | 'failure';

export type SourceItemOutcome =
  | 'retrieved'
  | 'non_content_rejected'
  | 'stale_rejected'
  | 'content_rejected'
  | 'duplicate_rejected'
  | 'history_rejected'
  | 'body_fetch_rejected'
  | 'body_unsafe_rejected'
  | 'body_timeout_rejected'
  | 'body_http_client_rejected'
  | 'body_http_server_rejected'
  | 'body_network_rejected'
  | 'body_type_rejected'
  | 'body_size_rejected'
  | 'body_redirect_rejected'
  | 'body_aborted_rejected'
  | 'keyword_rejected'
  | 'ai_rejected'
  | 'unsupported_claim'
  | 'conflicting_claim'
  | 'diversity_rejected'
  | 'composition_rejected'
  | 'accepted';

export interface SourceFunnelSink {
  recordSourceAttempt(input: {
    source: string;
    sourceType: SourceType;
    result: SourceAttemptResult;
    code?: string;
  }): void;
  recordSourceItems(input: {
    source: string;
    sourceType: SourceType;
    outcome: SourceItemOutcome;
    count: number;
  }): void;
}

export const recordSourceAttemptSafely = (
  sink: SourceFunnelSink | undefined,
  input: Parameters<SourceFunnelSink['recordSourceAttempt']>[0],
): void => {
  try {
    sink?.recordSourceAttempt(input);
  } catch {
    // Source telemetry must never change a discovery result.
  }
};

export const recordSourceCandidatesSafely = (
  sink: SourceFunnelSink | undefined,
  candidates: readonly ValidatedSourceCandidate[],
  outcome: SourceItemOutcome,
): void => {
  if (!sink || candidates.length === 0) return;
  const counts = new Map<string, {
    source: string;
    sourceType: SourceType;
    count: number;
  }>();
  for (const candidate of candidates) {
    const key = `${candidate.connectorId}\u0000${candidate.sourceType}`;
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, {
      source: candidate.connectorId,
      sourceType: candidate.sourceType,
      count: 1,
    });
  }
  for (const entry of counts.values()) {
    try {
      sink.recordSourceItems({ ...entry, outcome });
    } catch {
      // Source telemetry must never change a discovery result.
    }
  }
};

export const recordSourceDifferenceSafely = (
  sink: SourceFunnelSink | undefined,
  before: readonly ValidatedSourceCandidate[],
  after: readonly ValidatedSourceCandidate[],
  outcome: SourceItemOutcome,
): void => {
  if (!sink || before.length === 0) return;
  const survivors = new Map<string, number>();
  for (const candidate of after) {
    const key = `${candidate.connectorId}\u0000${candidate.sourceType}`;
    survivors.set(key, (survivors.get(key) ?? 0) + 1);
  }
  const rejected: ValidatedSourceCandidate[] = [];
  for (const candidate of before) {
    const key = `${candidate.connectorId}\u0000${candidate.sourceType}`;
    const remaining = survivors.get(key) ?? 0;
    if (remaining > 0) survivors.set(key, remaining - 1);
    else rejected.push(candidate);
  }
  recordSourceCandidatesSafely(sink, rejected, outcome);
};
