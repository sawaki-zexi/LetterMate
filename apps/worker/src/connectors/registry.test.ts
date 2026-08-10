import { type SourceCandidate, validateSourceCandidate } from '@lettermate/domain';
import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import {
  ConnectorError,
  type ConnectorResult,
  type SourceConnector,
  type SourceQueryPlan,
} from './types.js';
import { ConnectorRegistry } from './registry.js';

const plan: SourceQueryPlan = {
  keyword: 'AI agents',
  matchPolicy: buildKeywordPolicy('AI agents'),
  expandedTerms: ['agentic AI'],
  queries: ['AI agents latest'],
  sourceTypes: ['web'],
  windowStart: '2026-07-20T00:00:00.000Z',
  windowEnd: '2026-07-27T00:00:00.000Z',
  maxCandidates: 20,
};

const candidate = (connectorId: string): SourceCandidate => ({
  connectorId,
  sourceType: 'web',
  platform: 'Web',
  externalId: null,
  url: `https://example.com/${connectorId}`,
  title: connectorId,
  content: null,
  excerpt: null,
  authorName: null,
  authorHandle: null,
  publishedAt: null,
  language: 'en',
  engagement: {},
  proof: {
    kind: 'ai_citation',
    connectorId,
    citationUrl: `https://example.com/${connectorId}`,
  },
});

const normalizedCandidate = (connectorId: string) => validateSourceCandidate(candidate(connectorId));

const candidatesFor = (connectorId: string, count: number): SourceCandidate[] => (
  Array.from({ length: count }, (_, index) => {
    const value = candidate(connectorId);
    value.url = `https://example.com/${connectorId}-${index}`;
    value.title = `${connectorId}-${index}`;
    if (value.proof.kind === 'ai_citation') value.proof.citationUrl = value.url;
    return value;
  })
);

const connector = (
  id: string,
  overrides: Partial<SourceConnector> = {},
): SourceConnector => ({
  id,
  label: id,
  sourceType: 'web',
  isEnabled: () => true,
  supports: () => true,
  search: async () => ({ candidates: [] as SourceCandidate[] }),
  ...overrides,
});

describe('ConnectorRegistry', () => {
  it.each([
    ['', 'Safe message'],
    ['   ', 'Safe message'],
    ['CONNECTOR_FAILED', ''],
    ['CONNECTOR_FAILED', '   '],
  ])('rejects a ConnectorError with blank safe fields', (code, message) => {
    expect(() => new ConnectorError(code, message, true)).toThrow();
  });

  it('rejects duplicate connector IDs', () => {
    expect(
      () => new ConnectorRegistry([connector('web'), connector('web')], {
        concurrency: 2,
        timeoutMs: 1_000,
      }),
    ).toThrow('Duplicate connector ID: web');
  });

  it.each([
    [{ concurrency: 0, timeoutMs: 1_000 }, 'concurrency'],
    [{ concurrency: 17, timeoutMs: 1_000 }, 'concurrency'],
    [{ concurrency: 1.5, timeoutMs: 1_000 }, 'concurrency'],
    [{ concurrency: 2, timeoutMs: 0 }, 'timeoutMs'],
    [{ concurrency: 2, timeoutMs: Number.POSITIVE_INFINITY }, 'timeoutMs'],
  ])('rejects invalid registry options: %j', (options, field) => {
    expect(() => new ConnectorRegistry([], options)).toThrow(field);
  });

  it('retains validated options when the caller mutates its input', async () => {
    const options = { concurrency: 1, timeoutMs: 1_000 };
    const registry = new ConnectorRegistry([connector('stable')], options);
    options.concurrency = 0;

    await expect(registry.search(plan)).resolves.toMatchObject({
      successfulConnectorIds: ['stable'],
    });
  });

  it('skips disabled and unsupported connectors without searching them', async () => {
    const searched: string[] = [];
    const registry = new ConnectorRegistry([
      connector('disabled', {
        isEnabled: () => false,
        search: async () => {
          searched.push('disabled');
          return { candidates: [] };
        },
      }),
      connector('unsupported', {
        supports: () => false,
        search: async () => {
          searched.push('unsupported');
          return { candidates: [] };
        },
      }),
      connector('selected', {
        search: async () => {
          searched.push('selected');
          return { candidates: [candidate('selected')] };
        },
      }),
    ], { concurrency: 2, timeoutMs: 1_000 });

    await expect(registry.search(plan)).resolves.toEqual({
      candidates: [normalizedCandidate('selected')],
      successfulConnectorIds: ['selected'],
      skippedConnectorIds: ['disabled', 'unsupported'],
      failures: [],
    });
    expect(searched).toEqual(['selected']);
  });

  it('executes only the connector IDs selected by the topic route', async () => {
    const searched: string[] = [];
    const registry = new ConnectorRegistry([
      connector('selected', { search: async () => { searched.push('selected'); return { candidates: [] }; } }),
      connector('not-routed', { search: async () => { searched.push('not-routed'); return { candidates: [] }; } }),
    ], { concurrency: 2, timeoutMs: 1_000 });

    const result = await registry.search({ ...plan, connectorIds: ['selected'] });

    expect(searched).toEqual(['selected']);
    expect(result.successfulConnectorIds).toEqual(['selected']);
    expect(result.skippedConnectorIds).toEqual(['not-routed']);
  });

  it('round-robins successful connector results within the total candidate budget', async () => {
    const registry = new ConnectorRegistry([
      connector('first', { search: async () => ({ candidates: candidatesFor('first', 3) }) }),
      connector('second', { search: async () => ({ candidates: candidatesFor('second', 3) }) }),
    ], { concurrency: 2, timeoutMs: 1_000 });

    const result = await registry.search({
      ...plan,
      connectorIds: ['first', 'second'],
      maxCandidates: 3,
    });

    expect(result.candidates.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      'https://example.com/first-0',
      'https://example.com/second-0',
      'https://example.com/first-1',
    ]);
  });

  it('splits the total candidate budget across routed connectors', async () => {
    const receivedBudgets: number[] = [];
    const registry = new ConnectorRegistry([
      connector('first', { search: async (receivedPlan) => {
        receivedBudgets.push(receivedPlan.maxCandidates);
        return { candidates: [] };
      } }),
      connector('second', { search: async (receivedPlan) => {
        receivedBudgets.push(receivedPlan.maxCandidates);
        return { candidates: [] };
      } }),
    ], { concurrency: 2, timeoutMs: 1_000 });

    await registry.search({
      ...plan,
      connectorIds: ['first', 'second'],
      maxCandidates: 3,
    });

    expect(receivedBudgets).toEqual([2, 1]);
    expect(receivedBudgets.reduce((total, budget) => total + budget, 0)).toBe(3);
  });

  it('isolates a connector that throws while checking support', async () => {
    const registry = new ConnectorRegistry([
      connector('broken', {
        supports: () => {
          throw new Error('private connector setup failure');
        },
      }),
      connector('working', {
        search: async () => ({ candidates: [candidate('working')] }),
      }),
    ], { concurrency: 2, timeoutMs: 1_000 });

    await expect(registry.search(plan)).resolves.toEqual({
      candidates: [normalizedCandidate('working')],
      successfulConnectorIds: ['working'],
      skippedConnectorIds: [],
      failures: [{
        connectorId: 'broken',
        code: 'CONNECTOR_UPSTREAM_UNAVAILABLE',
        message: 'Connector is temporarily unavailable',
        retryable: true,
      }],
    });
  });

  it('runs at most the configured number of connectors concurrently', async () => {
    let active = 0;
    let maximumActive = 0;
    const release: Array<() => void> = [];
    const deferredConnector = (id: string) => connector(id, {
      search: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => release.push(resolve));
        active -= 1;
        return { candidates: [] };
      },
    });
    const registry = new ConnectorRegistry([
      deferredConnector('one'),
      deferredConnector('two'),
      deferredConnector('three'),
    ], { concurrency: 2, timeoutMs: 1_000 });

    const pending = registry.search(plan);
    await Promise.resolve();

    expect(release).toHaveLength(2);
    expect(maximumActive).toBe(2);

    release[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(release).toHaveLength(3);
    expect(maximumActive).toBe(2);

    release[1]?.();
    release[2]?.();
    await expect(pending).resolves.toMatchObject({
      successfulConnectorIds: ['one', 'two', 'three'],
    });
  });

  it('isolates one connector failure from successful candidates', async () => {
    const onFailure = vi.fn();
    const registry = new ConnectorRegistry([
      connector('failing', {
        search: async () => {
          throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Connector rate limited', true);
        },
      }),
      connector('working', {
        search: async () => ({ candidates: [candidate('working')] }),
      }),
    ], { concurrency: 2, timeoutMs: 1_000, onFailure });

    await expect(registry.search(plan)).resolves.toEqual({
      candidates: [normalizedCandidate('working')],
      successfulConnectorIds: ['working'],
      skippedConnectorIds: [],
      failures: [{
        connectorId: 'failing',
        code: 'CONNECTOR_RATE_LIMITED',
        message: 'Connector rate limited',
        retryable: true,
      }],
      });
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      connectorId: 'failing', code: 'CONNECTOR_RATE_LIMITED',
    }));
  });

  it('records one bounded attempt result per selected connector without affecting search', async () => {
    const sourceTelemetry = {
      recordSourceAttempt: vi.fn(),
      recordSourceItems: vi.fn(),
    };
    const registry = new ConnectorRegistry([
      connector('working', {
        sourceType: 'web',
        search: async () => ({ candidates: [candidate('working')] }),
      }),
      connector('broken', {
        sourceType: 'code',
        search: async () => {
          throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Rate limited', true);
        },
      }),
    ], { concurrency: 2, timeoutMs: 1_000, sourceTelemetry });

    await expect(registry.search(plan)).resolves.toMatchObject({
      successfulConnectorIds: ['working'],
      failures: [expect.objectContaining({ connectorId: 'broken' })],
    });
    expect(sourceTelemetry.recordSourceAttempt.mock.calls.map(([input]) => input)).toEqual([
      { source: 'working', sourceType: 'web', result: 'success' },
      {
        source: 'broken', sourceType: 'code', result: 'failure',
        code: 'CONNECTOR_RATE_LIMITED',
      },
    ]);
    expect(sourceTelemetry.recordSourceItems).not.toHaveBeenCalled();
  });

  it('maps unknown errors to a generic safe failure', async () => {
    const registry = new ConnectorRegistry([
      connector('unknown', {
        search: async () => {
          throw new Error('private response containing api-key-secret');
        },
      }),
    ], { concurrency: 1, timeoutMs: 1_000 });

    const summary = await registry.search(plan);

    expect(summary).toEqual({
      candidates: [],
      successfulConnectorIds: [],
      skippedConnectorIds: [],
      failures: [{
        connectorId: 'unknown',
        code: 'CONNECTOR_UPSTREAM_UNAVAILABLE',
        message: 'Connector is temporarily unavailable',
        retryable: true,
      }],
    });
    expect(JSON.stringify(summary)).not.toContain('api-key-secret');
  });

  it.each([
    ['non-object', null],
    ['array', []],
    ['non-array candidates', { candidates: 'invalid' }],
  ])('maps a malformed %s result to a response failure', async (_label, result) => {
    const registry = new ConnectorRegistry([
      connector('malformed', {
        search: async () => result as unknown as ConnectorResult,
      }),
    ], { concurrency: 1, timeoutMs: 1_000 });

    await expect(registry.search(plan)).resolves.toMatchObject({
      successfulConnectorIds: [],
      failures: [{
        connectorId: 'malformed',
        code: 'CONNECTOR_RESPONSE_INVALID',
        message: 'Connector returned an invalid response',
        retryable: false,
      }],
    });
  });

  it('isolates a connector whose candidate fails source-proof validation', async () => {
    const invalid = candidate('invalid');
    invalid.url = 'not a URL';
    const registry = new ConnectorRegistry([
      connector('invalid', {
        search: async () => ({ candidates: [invalid] }),
      }),
    ], { concurrency: 1, timeoutMs: 1_000 });

    await expect(registry.search(plan)).resolves.toEqual({
      candidates: [],
      successfulConnectorIds: [],
      skippedConnectorIds: [],
      failures: [{
        connectorId: 'invalid',
        code: 'CONNECTOR_RESPONSE_INVALID',
        message: 'Connector returned an invalid response',
        retryable: false,
      }],
    });
  });

  it('aborts a connector and records a retryable timeout failure', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    try {
      const registry = new ConnectorRegistry([
        connector('slow', {
          search: async (_plan, signal) => {
            observedSignal = signal;
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { candidates: [] };
          },
        }),
      ], { concurrency: 1, timeoutMs: 10 });

      const pending = registry.search(plan);
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({
        successfulConnectorIds: [],
        failures: [{
          connectorId: 'slow',
          code: 'CONNECTOR_TIMEOUT',
          message: 'Connector search timed out',
          retryable: true,
        }],
      });
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates parent cancellation and does not start queued connectors', async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    let runningSignal: AbortSignal | undefined;
    try {
      const hangingConnector = (id: string) => connector(id, {
        search: async (_plan, signal) => {
          started.push(id);
          if (id === 'one') runningSignal = signal;
          await new Promise(() => undefined);
          return { candidates: [] };
        },
      });
      const registry = new ConnectorRegistry([
        hangingConnector('one'),
        hangingConnector('two'),
        hangingConnector('three'),
      ], { concurrency: 1, timeoutMs: 100 });
      const parent = new AbortController();

      const pending = registry.search(plan, parent.signal);
      await Promise.resolve();
      expect(started).toEqual(['one']);

      parent.abort();
      await vi.advanceTimersByTimeAsync(300);

      await expect(pending).resolves.toEqual({
        candidates: [],
        successfulConnectorIds: [],
        skippedConnectorIds: [],
        failures: ['one', 'two', 'three'].map((connectorId) => ({
          connectorId,
          code: 'CONNECTOR_ABORTED',
          message: 'Connector search was aborted',
          retryable: true,
        })),
      });
      expect(started).toEqual(['one']);
      expect(runningSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles a connector rejection that arrives after timeout', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', recordUnhandled);
    try {
      const registry = new ConnectorRegistry([
        connector('late', {
          search: async () => new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('late private response')), 50);
          }),
        }),
      ], { concurrency: 1, timeoutMs: 10 });

      const pending = registry.search(plan);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({
        failures: [{ code: 'CONNECTOR_TIMEOUT' }],
      });

      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', recordUnhandled);
      vi.useRealTimers();
    }
  });

  it('preserves declaration order when connectors complete in reverse', async () => {
    const release = new Map<string, () => void>();
    const deferred = (id: string, succeeds: boolean) => connector(id, {
      search: async () => {
        await new Promise<void>((resolve) => release.set(id, resolve));
        if (!succeeds) {
          throw new ConnectorError(`FAILED_${id.toUpperCase()}`, `Failed ${id}`, false);
        }
        return { candidates: [candidate(id)] };
      },
    });
    const registry = new ConnectorRegistry([
      deferred('one', true),
      deferred('two', false),
      deferred('three', true),
      deferred('four', false),
    ], { concurrency: 4, timeoutMs: 1_000 });

    const pending = registry.search(plan);
    await Promise.resolve();
    expect(release.size).toBe(4);
    for (const id of ['four', 'three', 'two', 'one']) release.get(id)?.();

    await expect(pending).resolves.toEqual({
      candidates: [normalizedCandidate('one'), normalizedCandidate('three')],
      successfulConnectorIds: ['one', 'three'],
      skippedConnectorIds: [],
      failures: [
        {
          connectorId: 'two',
          code: 'FAILED_TWO',
          message: 'Failed two',
          retryable: false,
        },
        {
          connectorId: 'four',
          code: 'FAILED_FOUR',
          message: 'Failed four',
          retryable: false,
        },
      ],
    });
  });

  it('counts a zero-candidate result as a successful connector', async () => {
    const registry = new ConnectorRegistry([
      connector('empty'),
    ], { concurrency: 1, timeoutMs: 1_000 });

    await expect(registry.search(plan)).resolves.toEqual({
      candidates: [],
      successfulConnectorIds: ['empty'],
      skippedConnectorIds: [],
      failures: [],
    });
  });

  it('defensively copies connector candidate arrays', async () => {
    const connectorCandidates = [candidate('copied')];
    const registry = new ConnectorRegistry([
      connector('copied', {
        search: async () => ({ candidates: connectorCandidates }),
      }),
    ], { concurrency: 1, timeoutMs: 1_000 });

    const summary = await registry.search(plan);
    connectorCandidates.push(candidate('later'));

    expect(summary.candidates).toEqual([normalizedCandidate('copied')]);
    expect(summary.candidates).not.toBe(connectorCandidates);
  });

  it('returns normalized candidate objects that cannot be mutated by a connector later', async () => {
    const connectorCandidate = candidate('isolated');
    const registry = new ConnectorRegistry([
      connector('isolated', {
        search: async () => ({ candidates: [connectorCandidate] }),
      }),
    ], { concurrency: 1, timeoutMs: 1_000 });

    const summary = await registry.search(plan);
    connectorCandidate.engagement.likes = 99;
    connectorCandidate.proof.connectorId = 'changed';

    expect(summary.candidates).toEqual([normalizedCandidate('isolated')]);
  });

  it('gives each connector an isolated query plan', async () => {
    const observedQueries: string[] = [];
    const registry = new ConnectorRegistry([
      connector('mutating', {
        search: async (queryPlan) => {
          queryPlan.queries.push('poisoned query');
          return { candidates: [] };
        },
      }),
      connector('observing', {
        search: async (queryPlan) => {
          observedQueries.push(...queryPlan.queries);
          return { candidates: [] };
        },
      }),
    ], { concurrency: 1, timeoutMs: 1_000 });

    await registry.search(plan);

    expect(observedQueries).toEqual(['AI agents latest']);
    expect(plan.queries).toEqual(['AI agents latest']);
  });
});
