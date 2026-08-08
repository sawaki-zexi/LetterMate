import type { ValidatedSourceCandidate } from '@lettermate/domain';
import {
  EVIDENCE_FOLLOWUP_MAX_CANDIDATES,
  EVIDENCE_FOLLOWUP_MAX_CONNECTORS,
  EVIDENCE_FOLLOWUP_MAX_REQUIRED_TERMS,
  type AiGateway,
  type EvidenceFollowupDecision,
} from './ai-gateway.js';
import type {
  ConnectorSearchSummary,
  SourceQueryPlan,
} from './connectors/types.js';
import {
  buildRequiredKeywordPolicy,
  filterQueriesForPolicy,
} from './keyword-policy.js';
import type { AiExecutionContext } from './ai-runtime.js';
import type { RunStageManager } from './run-stage.js';

export {
  EVIDENCE_FOLLOWUP_MAX_CANDIDATES,
  EVIDENCE_FOLLOWUP_MAX_CONNECTORS,
  EVIDENCE_FOLLOWUP_MAX_REQUIRED_TERMS,
} from './ai-gateway.js';

interface ConnectorRegistryLike {
  search(plan: SourceQueryPlan, signal?: AbortSignal): Promise<ConnectorSearchSummary>;
}

export interface EvidenceGapRetrieverInput {
  execution: AiExecutionContext;
  plan: SourceQueryPlan;
  initial: ConnectorSearchSummary;
  signal?: AbortSignal;
}

const hasUrl = (value: string): boolean => /(?:https?:\/\/|www\.)/iu.test(value);

const unique = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const mergeCandidates = (
  initial: readonly ValidatedSourceCandidate[],
  followup: readonly ValidatedSourceCandidate[],
): ValidatedSourceCandidate[] => {
  const seen = new Set<string>();
  const merged: ValidatedSourceCandidate[] = [];
  for (const candidate of [...initial, ...followup]) {
    if (seen.has(candidate.canonicalUrl)) continue;
    seen.add(candidate.canonicalUrl);
    merged.push(candidate);
  }
  return merged;
};

const mergeSummary = (
  initial: ConnectorSearchSummary,
  followup: ConnectorSearchSummary,
): ConnectorSearchSummary => {
  const successfulConnectorIds = unique([
    ...initial.successfulConnectorIds,
    ...followup.successfulConnectorIds,
  ]);
  const failures = [...initial.failures, ...followup.failures];
  const attempted = new Set([
    ...successfulConnectorIds,
    ...failures.map(({ connectorId }) => connectorId),
  ]);
  const skippedConnectorIds = unique([
    ...initial.skippedConnectorIds,
    ...followup.skippedConnectorIds,
  ]).filter((connectorId) => !attempted.has(connectorId));
  return {
    candidates: mergeCandidates(initial.candidates, followup.candidates),
    successfulConnectorIds,
    skippedConnectorIds,
    failures,
  };
};

export class EvidenceGapRetriever {
  constructor(
    private readonly gateway: Pick<AiGateway, 'planEvidenceFollowup'>,
    private readonly connectors: ConnectorRegistryLike,
    private readonly stageManager?: RunStageManager,
  ) {}

  async retrieve(input: EvidenceGapRetrieverInput): Promise<ConnectorSearchSummary> {
    const allowedConnectorIds = unique(input.plan.connectorIds ?? []);
    if (allowedConnectorIds.length === 0) return input.initial;

    const execute = async (): Promise<ConnectorSearchSummary> => {
      const decision = await this.gateway.planEvidenceFollowup({
        keyword: input.plan.keyword,
        originalQueries: [...input.plan.queries],
        allowedConnectorIds,
        successfulConnectorIds: [...input.initial.successfulConnectorIds],
        failureCodes: input.initial.failures.map(({ connectorId, code }) => ({ connectorId, code })),
        candidates: input.initial.candidates.map((candidate) => ({
          connectorId: candidate.connectorId,
          title: candidate.title,
          content: candidate.content,
          excerpt: candidate.excerpt,
          publishedAt: candidate.publishedAt,
          proofKind: candidate.proof.kind,
        })),
        execution: input.execution,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (decision === null) return input.initial;
      const followupPlan = this.toFollowupPlan(input.plan, decision, allowedConnectorIds);
      if (followupPlan === null) return input.initial;
      const followup = await this.connectors.search(followupPlan, input.signal);
      return mergeSummary(input.initial, followup);
    };

    try {
      return this.stageManager
        ? await this.stageManager.run({
            execution: input.execution,
            stage: 'followup',
            value: { plan: input.plan, initial: input.initial },
            execute,
          })
        : await execute();
    } catch {
      return input.initial;
    }
  }

  private toFollowupPlan(
    plan: SourceQueryPlan,
    decision: EvidenceFollowupDecision,
    allowedConnectorIds: readonly string[],
  ): SourceQueryPlan | null {
    const query = decision.query.trim();
    const connectorIds = unique(decision.connectorIds);
    const requiredTerms = unique(decision.requiredTerms);
    const allowed = new Set(allowedConnectorIds);
    if (
      !query
      || hasUrl(query)
      || decision.connectorIds.some(hasUrl)
      || requiredTerms.some(hasUrl)
      || connectorIds.length === 0
      || connectorIds.length > EVIDENCE_FOLLOWUP_MAX_CONNECTORS
      || connectorIds.some((connectorId) => !allowed.has(connectorId))
      || requiredTerms.length === 0
      || requiredTerms.length > EVIDENCE_FOLLOWUP_MAX_REQUIRED_TERMS
      || filterQueriesForPolicy([query], plan.matchPolicy).length !== 1
    ) return null;

    let preservesRequiredTerms = false;
    try {
      const requiredPolicy = buildRequiredKeywordPolicy(requiredTerms);
      preservesRequiredTerms = filterQueriesForPolicy([query], requiredPolicy).length === 1;
    } catch {
      return null;
    }
    if (!preservesRequiredTerms) return null;

    return {
      ...plan,
      expandedTerms: unique([...plan.expandedTerms, ...requiredTerms]),
      queries: [query],
      connectorIds,
      maxCandidates: EVIDENCE_FOLLOWUP_MAX_CANDIDATES,
    };
  }
}
