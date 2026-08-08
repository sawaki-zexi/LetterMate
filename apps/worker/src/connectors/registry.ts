import {
  ConnectorError,
  type ConnectorFailure,
  type ConnectorSearchSummary,
  type SourceConnector,
  type SourceQueryPlan,
} from './types.js';
import { type ValidatedSourceCandidate, validateSourceCandidate } from '@lettermate/domain';

interface ValidatedConnectorResult {
  candidates: ValidatedSourceCandidate[];
  requestCount?: number;
}

export interface ConnectorRegistryOptions {
  concurrency: number;
  timeoutMs: number;
  onFailure?: (failure: ConnectorFailure) => void;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const toFailure = (connectorId: string, error: unknown): ConnectorFailure => ({
  connectorId,
  code: error instanceof ConnectorError ? error.code : 'CONNECTOR_UPSTREAM_UNAVAILABLE',
  message: error instanceof ConnectorError ? error.message : 'Connector is temporarily unavailable',
  retryable: error instanceof ConnectorError ? error.retryable : true,
});

const copyPlan = (plan: SourceQueryPlan): SourceQueryPlan => ({
  ...plan,
  expandedTerms: [...plan.expandedTerms],
  queries: [...plan.queries],
  sourceTypes: [...plan.sourceTypes],
  ...(plan.connectorIds ? { connectorIds: [...plan.connectorIds] } : {}),
});

export class ConnectorRegistry {
  private readonly connectors: readonly SourceConnector[];
  private readonly options: ConnectorRegistryOptions;

  constructor(connectors: readonly SourceConnector[], options: ConnectorRegistryOptions) {
    if (
      !Number.isInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > 16
    ) {
      throw new Error('concurrency must be an integer from 1 to 16');
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive finite number');
    }

    const ids = new Set<string>();
    for (const connector of connectors) {
      if (ids.has(connector.id)) {
        throw new Error(`Duplicate connector ID: ${connector.id}`);
      }
      ids.add(connector.id);
    }
    this.connectors = [...connectors];
    this.options = { ...options };
  }

  async search(
    plan: SourceQueryPlan,
    parentSignal?: AbortSignal,
  ): Promise<ConnectorSearchSummary> {
    const selected: Array<{ connector: SourceConnector; resultIndex: number }> = [];
    const skippedConnectorIds: string[] = [];
    const results: Array<ValidatedConnectorResult | ConnectorFailure | undefined> = new Array(
      this.connectors.length,
    );
    const routedConnectorIds = plan.connectorIds ? new Set(plan.connectorIds) : undefined;
    for (const [index, connector] of this.connectors.entries()) {
      try {
        if (routedConnectorIds !== undefined && !routedConnectorIds.has(connector.id)) {
          skippedConnectorIds.push(connector.id);
        } else if (connector.isEnabled() && connector.supports(copyPlan(plan))) {
          selected.push({ connector, resultIndex: index });
        } else {
          skippedConnectorIds.push(connector.id);
        }
      } catch (error) {
        results[index] = toFailure(connector.id, error);
      }
    }
    const candidateLimit = Math.max(0, Math.floor(plan.maxCandidates));
    const baseCandidateBudget = selected.length === 0
      ? 0
      : Math.floor(candidateLimit / selected.length);
    const connectorPlans = selected.map((selectedConnector, index) => ({
      ...selectedConnector,
      plan: {
        ...copyPlan(plan),
        maxCandidates: baseCandidateBudget + (index < candidateLimit % selected.length ? 1 : 0),
      },
    }));

    let nextIndex = 0;
    let cancelled = parentSignal?.aborted ?? false;
    const markCancelled = () => {
      cancelled = true;
    };
    parentSignal?.addEventListener('abort', markCancelled, { once: true });
    const worker = async () => {
      while (!cancelled && nextIndex < connectorPlans.length) {
        const index = nextIndex;
        nextIndex += 1;
        const selectedConnector = connectorPlans[index];
        if (selectedConnector === undefined) continue;
        const { connector, resultIndex, plan: connectorPlan } = selectedConnector;
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let cancelConnector: (() => void) | undefined;
        try {
          const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              reject(
                new ConnectorError(
                  'CONNECTOR_TIMEOUT',
                  'Connector search timed out',
                  true,
                ),
              );
            }, this.options.timeoutMs);
          });
          const cancellation = new Promise<never>((_resolve, reject) => {
            if (parentSignal === undefined) return;
            cancelConnector = () => {
              controller.abort();
              reject(
                new ConnectorError(
                  'CONNECTOR_ABORTED',
                  'Connector search was aborted',
                  true,
                ),
              );
            };
            if (parentSignal.aborted) cancelConnector();
            else parentSignal.addEventListener('abort', cancelConnector, { once: true });
          });
          const result: unknown = await Promise.race(
            [connector.search(connectorPlan, controller.signal), timeout, cancellation],
          );
          if (!isPlainObject(result) || !Array.isArray(result.candidates)) {
            results[resultIndex] = {
              connectorId: connector.id,
              code: 'CONNECTOR_RESPONSE_INVALID',
              message: 'Connector returned an invalid response',
              retryable: false,
            };
            continue;
          }
          let candidates: ValidatedSourceCandidate[];
          try {
            candidates = result.candidates.map((item) => {
              const candidate = validateSourceCandidate(item);
              if (candidate.connectorId !== connector.id) {
                throw new Error('Candidate connector ID does not match connector');
              }
              return candidate;
            });
          } catch {
            results[resultIndex] = {
              connectorId: connector.id,
              code: 'CONNECTOR_RESPONSE_INVALID',
              message: 'Connector returned an invalid response',
              retryable: false,
            };
            continue;
          }
          results[resultIndex] = {
            candidates,
            requestCount: typeof result.requestCount === 'number' &&
              Number.isInteger(result.requestCount) && result.requestCount >= 0
              ? result.requestCount
              : 1,
          };
        } catch (error) {
          results[resultIndex] = toFailure(connector.id, error);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (cancelConnector !== undefined) {
            parentSignal?.removeEventListener('abort', cancelConnector);
          }
        }
      }
    };
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(this.options.concurrency, connectorPlans.length) },
          worker,
        ),
      );
    } finally {
      parentSignal?.removeEventListener('abort', markCancelled);
    }

    if (cancelled) {
      for (const { connector, resultIndex } of connectorPlans) {
        results[resultIndex] ??= {
          connectorId: connector.id,
          code: 'CONNECTOR_ABORTED',
          message: 'Connector search was aborted',
          retryable: true,
        };
      }
    }

    const candidates: ConnectorSearchSummary['candidates'] = [];
    const candidateLists: ValidatedSourceCandidate[][] = [];
    const successfulConnectorIds: string[] = [];
    const failures: ConnectorFailure[] = [];
    for (const [index, result] of results.entries()) {
      if (result === undefined) continue;
      if ('candidates' in result) {
        candidateLists.push(result.candidates);
        const connector = this.connectors[index];
        if (connector !== undefined) successfulConnectorIds.push(connector.id);
      } else {
        failures.push(result);
      }
    }
    for (let candidateIndex = 0; candidates.length < candidateLimit; candidateIndex += 1) {
      let added = false;
      for (const candidateList of candidateLists) {
        const candidate = candidateList[candidateIndex];
        if (candidate === undefined) continue;
        candidates.push(candidate);
        added = true;
        if (candidates.length === candidateLimit) break;
      }
      if (!added) break;
    }
    for (const failure of failures) this.options.onFailure?.(failure);

    return {
      candidates,
      successfulConnectorIds,
      skippedConnectorIds,
      failures,
    };
  }
}
