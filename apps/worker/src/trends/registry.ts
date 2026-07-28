import { z } from 'zod';
import { MAX_TREND_EXTERNAL_ID_LENGTH, MAX_TREND_TITLE_LENGTH, MAX_TREND_URL_LENGTH } from './candidate.js';
import {
  TrendSourceError,
  type TrendCollectionSummary,
  type TrendSeedCandidate,
  type TrendSource,
  type TrendSourceFailure,
  type TrendSourceResult,
  type TrendWindow,
} from './types.js';

export interface TrendSourceRegistryOptions {
  concurrency: number;
  timeoutMs: number;
}

const isoTimestamp = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});

const candidateSchema = z.object({
  sourceId: z.string().trim().min(1).max(100),
  platform: z.string().trim().min(1).max(100),
  externalId: z.string().trim().min(1).max(MAX_TREND_EXTERNAL_ID_LENGTH),
  title: z.string().trim().min(1).max(MAX_TREND_TITLE_LENGTH),
  url: z.string().trim().min(1).max(MAX_TREND_URL_LENGTH),
  publishedAt: isoTimestamp.nullable(),
}).strict();

const resultSchema = z.object({
  candidates: z.array(z.unknown()),
  requestCount: z.number().int().nonnegative(),
}).strict();

const trackingParameter = /^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i;

const canonicalizeUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TrendSourceError(
      'TREND_SOURCE_RESPONSE_INVALID',
      'Trend source returned an invalid response',
      false,
    );
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new TrendSourceError(
      'TREND_SOURCE_RESPONSE_INVALID',
      'Trend source returned an invalid response',
      false,
    );
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParameter.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
};

const safeFailure = (sourceId: string, error: unknown): TrendSourceFailure => ({
  sourceId,
  code: error instanceof TrendSourceError ? error.code : 'TREND_SOURCE_UNAVAILABLE',
  message: error instanceof TrendSourceError
    ? error.message
    : 'Trend source is temporarily unavailable',
  retryable: error instanceof TrendSourceError ? error.retryable : true,
});

const responseError = (): TrendSourceError => new TrendSourceError(
  'TREND_SOURCE_RESPONSE_INVALID',
  'Trend source returned an invalid response',
  false,
);

const validateWindow = (window: TrendWindow): void => {
  for (const [name, value] of [
    ['maxCandidates', window.maxCandidates],
    ['requestBudget', window.requestBudget],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  }
  const start = Date.parse(window.windowStart);
  const end = Date.parse(window.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('Trend window timestamps are invalid');
  }
};

export class TrendSourceRegistry {
  private readonly sources: readonly TrendSource[];
  private readonly options: TrendSourceRegistryOptions;
  private rotationOffset = 0;

  constructor(sources: readonly TrendSource[], options: TrendSourceRegistryOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
      throw new Error('concurrency must be an integer from 1 to 16');
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive finite number');
    }
    const ids = new Set<string>();
    for (const source of sources) {
      if (!source.id.trim()) throw new Error('Trend source ID must not be blank');
      if (ids.has(source.id)) throw new Error(`Duplicate trend source ID: ${source.id}`);
      ids.add(source.id);
      const minimum = source.minimumRequestBudget ?? 1;
      if (!Number.isInteger(minimum) || minimum < 1) {
        throw new Error(`minimumRequestBudget for ${source.id} must be a positive integer`);
      }
    }
    this.sources = [...sources];
    this.options = { ...options };
  }

  async collect(window: TrendWindow, parentSignal?: AbortSignal): Promise<TrendCollectionSummary> {
    validateWindow(window);
    const skippedSourceIdSet = new Set<string>();
    const failuresByIndex: Array<TrendSourceFailure | undefined> = new Array(this.sources.length);
    const selected: Array<{ source: TrendSource; index: number }> = [];
    for (const [index, source] of this.sources.entries()) {
      try {
        if (source.isEnabled()) selected.push({ source, index });
        else skippedSourceIdSet.add(source.id);
      } catch (error) {
        failuresByIndex[index] = safeFailure(source.id, error);
      }
    }

    const rotation = selected.length === 0 ? 0 : this.rotationOffset % selected.length;
    if (selected.length > 0) this.rotationOffset = (rotation + 1) % selected.length;
    const ordered = [...selected.slice(rotation), ...selected.slice(0, rotation)];
    let remainingBudget = window.requestBudget;
    const allocations: Array<{ source: TrendSource; index: number; budget: number }> = [];
    for (const entry of ordered) {
      const minimum = entry.source.minimumRequestBudget ?? 1;
      if (minimum <= remainingBudget) {
        allocations.push({ ...entry, budget: minimum });
        remainingBudget -= minimum;
      } else {
        skippedSourceIdSet.add(entry.source.id);
      }
    }
    for (let index = 0; remainingBudget > 0 && allocations.length > 0; index += 1) {
      allocations[index % allocations.length]!.budget += 1;
      remainingBudget -= 1;
    }
    const skippedSourceIds = this.sources
      .map(({ id }) => id)
      .filter((id) => skippedSourceIdSet.has(id));
    const results: Array<TrendSourceResult | undefined> = new Array(this.sources.length);
    const accountedCounts: number[] = new Array(this.sources.length).fill(0);
    let next = 0;
    let cancelled = parentSignal?.aborted ?? false;
    const markCancelled = () => { cancelled = true; };
    parentSignal?.addEventListener('abort', markCancelled, { once: true });

    const worker = async (): Promise<void> => {
      while (!cancelled && next < allocations.length) {
        const allocation = allocations[next];
        next += 1;
        if (!allocation) continue;
        const { source, index, budget } = allocation;
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let abortParent: (() => void) | undefined;
        try {
          const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              reject(new TrendSourceError(
                'TREND_SOURCE_TIMEOUT',
                'Trend source collection timed out',
                true,
              ));
            }, this.options.timeoutMs);
          });
          const cancellation = new Promise<never>((_resolve, reject) => {
            if (!parentSignal) return;
            abortParent = () => {
              controller.abort();
              reject(new TrendSourceError(
                'TREND_SOURCE_ABORTED',
                'Trend source collection was aborted',
                true,
              ));
            };
            if (parentSignal.aborted) abortParent();
            else parentSignal.addEventListener('abort', abortParent, { once: true });
          });
          const recordRequest = () => {
            if (accountedCounts[index]! >= budget) {
              throw new TrendSourceError(
                'TREND_SOURCE_REQUEST_BUDGET_EXCEEDED',
                'Trend source exceeded its request budget',
                false,
              );
            }
            accountedCounts[index]! += 1;
          };
          const raw: unknown = await Promise.race([
            source.collect({ ...window, requestBudget: budget, recordRequest }, controller.signal),
            timeout,
            cancellation,
          ]);
          const parsed = resultSchema.safeParse(raw);
          if (!parsed.success) throw responseError();
          const reconciledCount = Math.max(accountedCounts[index]!, parsed.data.requestCount);
          if (reconciledCount > budget) throw responseError();
          accountedCounts[index] = reconciledCount;
          const candidates = parsed.data.candidates.map((rawCandidate) => {
            const candidate = candidateSchema.safeParse(rawCandidate);
            if (!candidate.success || candidate.data.sourceId !== source.id) throw responseError();
            return { ...candidate.data, url: canonicalizeUrl(candidate.data.url) };
          });
          results[index] = { candidates, requestCount: reconciledCount };
        } catch (error) {
          failuresByIndex[index] = safeFailure(source.id, error);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (abortParent) parentSignal?.removeEventListener('abort', abortParent);
        }
      }
    };

    try {
      await Promise.all(Array.from(
        { length: Math.min(this.options.concurrency, allocations.length) },
        () => worker(),
      ));
    } finally {
      parentSignal?.removeEventListener('abort', markCancelled);
    }

    if (cancelled) {
      for (const { source, index } of allocations) {
        if (!results[index] && !failuresByIndex[index]) {
          failuresByIndex[index] = safeFailure(source.id, new TrendSourceError(
            'TREND_SOURCE_ABORTED',
            'Trend source collection was aborted',
            true,
          ));
        }
      }
    }

    const successfulSourceIds: string[] = [];
    const requestCounts: Record<string, number> = {};
    const queues: TrendSeedCandidate[][] = [];
    for (const [index, source] of this.sources.entries()) {
      const result = results[index];
      const accountedCount = accountedCounts[index] ?? 0;
      if (accountedCount > 0 || result) requestCounts[source.id] = accountedCount;
      if (result) successfulSourceIds.push(source.id);
    }
    for (const { index } of allocations) {
      const result = results[index];
      if (result) {
        queues.push([...result.candidates]);
      }
    }
    const candidates: TrendSeedCandidate[] = [];
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    while (candidates.length < window.maxCandidates && queues.some((queue) => queue.length > 0)) {
      for (const queue of queues) {
        const item = queue.shift();
        if (!item) continue;
        const identity = `${item.sourceId}\u0000${item.externalId}`;
        if (seenIds.has(identity) || seenUrls.has(item.url)) continue;
        seenIds.add(identity);
        seenUrls.add(item.url);
        candidates.push({ ...item });
        if (candidates.length >= window.maxCandidates) break;
      }
    }
    return {
      candidates,
      successfulSourceIds,
      skippedSourceIds,
      failures: failuresByIndex.filter((failure): failure is TrendSourceFailure => failure !== undefined),
      requestCount: Object.values(requestCounts).reduce((sum, count) => sum + count, 0),
      requestCounts,
    };
  }
}
