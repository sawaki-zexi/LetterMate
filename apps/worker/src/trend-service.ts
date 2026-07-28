import { createHash, randomUUID } from 'node:crypto';
import type {
  DiscoveryCandidate,
  DiscoveryTrigger,
  SafeError,
  SourceType,
} from '@lettermate/contracts';
import { canonicalizeUrl } from '@lettermate/domain';
import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  AiGateway,
  TrendSeedClassificationInput,
  TrendSeedDecision,
} from './ai-gateway.js';
import type { ConnectorSearchSummary, SourceQueryPlan } from './connectors/types.js';
import {
  buildRequiredKeywordPolicy,
  filterQueriesForPolicy,
} from './keyword-policy.js';
import type { QualityPipelineInput } from './quality-pipeline.js';
import type { TrendCollectionSummary, TrendSeedCandidate, TrendWindow } from './trends/types.js';

const HOUR_MS = 60 * 60 * 1_000;
const RECENT_SEED_MS = 24 * HOUR_MS;
const CLASSIFICATION_BATCH_SIZE = 20;

export interface SanitizedTrendSeed {
  fingerprint: string;
  sourceId: string;
  platform: string;
  externalId: string | null;
  title: string;
  sourceUrl: string;
  publishedAt: Date | null;
  normalizedQuery: string | null;
}

export type TrendRunClaim = {
  state: 'claimed';
  runId: string;
  monitorId: string;
  intervalHours: number;
  nextRunAt: Date;
} | {
  state: 'active';
  followUpManualRegistered: boolean;
} | {
  state: 'missing';
};

export interface CompleteTrendRunInput {
  runId: string;
  monitorId: string;
  userId: string;
  trigger: DiscoveryTrigger;
  candidateCount: number;
  acceptedCount: number;
  items: DiscoveryCandidate[];
  finishedAt: Date;
}

export interface TrendRepository {
  claimRun(userId: string, trigger: DiscoveryTrigger, startedAt: Date): Promise<TrendRunClaim>;
  listRecentFingerprints(
    userId: string,
    fingerprints: string[],
    discoveredSince: Date,
  ): Promise<Set<string>>;
  saveSeeds(input: { runId: string; userId: string; seeds: SanitizedTrendSeed[] }): Promise<void>;
  listHistoryUrls(userId: string): Promise<string[]>;
  completeSuccess(input: CompleteTrendRunInput): Promise<{
    newItemCount: number;
    followUpManual: boolean;
  }>;
  completeFailure(input: {
    runId: string;
    monitorId: string;
    userId: string;
    trigger: DiscoveryTrigger;
    error: SafeError;
    finishedAt: Date;
    status: 'queued' | 'failed';
  }): Promise<{ followUpManual: boolean }>;
}

const safeError = (error: unknown): SafeError => {
  if (error instanceof TrendOrchestrationError) {
    return { code: error.code, message: error.message };
  }
  if (typeof error === 'object' && error !== null && 'code' in error && 'retryable' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('AI_')) {
      return { code, message: 'AI processing is temporarily unavailable' };
    }
  }
  return { code: 'TREND_RUN_FAILED', message: 'Trend discovery is temporarily unavailable' };
};

const unique = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const normalized = trimmed.normalize('NFKC').toLowerCase();
    if (!trimmed || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
};

const fingerprintSeed = (seed: TrendSeedCandidate): string => createHash('sha256')
  .update(JSON.stringify([
    seed.sourceId.trim().toLowerCase(),
    seed.externalId.trim().toLowerCase(),
    seed.title.normalize('NFKC').trim().toLowerCase(),
    canonicalizeUrl(seed.url),
  ]))
  .digest('hex');

const sanitizeSeed = (seed: TrendSeedCandidate): Omit<SanitizedTrendSeed, 'normalizedQuery'> => ({
  fingerprint: fingerprintSeed(seed),
  sourceId: seed.sourceId.trim().slice(0, 100),
  platform: seed.platform.trim().slice(0, 100),
  externalId: seed.externalId.trim().slice(0, 500) || null,
  title: seed.title.normalize('NFKC').trim().slice(0, 500),
  sourceUrl: canonicalizeUrl(seed.url),
  publishedAt: seed.publishedAt === null ? null : new Date(seed.publishedAt),
});

const sourceTypes: SourceType[] = ['web', 'feed', 'social', 'video', 'community', 'code', 'paper'];

const buildTrendPlan = (
  decision: TrendSeedDecision,
  windowStart: string,
  windowEnd: string,
  maxCandidates: number,
): SourceQueryPlan => {
  if (!decision.accepted || decision.query === null) throw new Error('Accepted trend decision required');
  const requiredTerms = unique(decision.requiredTerms);
  const matchPolicy = buildRequiredKeywordPolicy(requiredTerms, decision.query);
  const quotedTerms = requiredTerms.map((term) => `"${term}"`).join(' ');
  const generated = [
    `${quotedTerms} announcement`,
    `${quotedTerms} release notes`,
    `${quotedTerms} official`,
    decision.query,
  ];
  const queries = unique(filterQueriesForPolicy(generated, matchPolicy));
  if (queries.length === 0) {
    throw new TrendOrchestrationError(
      'TREND_DECISION_INVALID',
      'Trend classification response is invalid',
      false,
    );
  }
  return {
    keyword: decision.query,
    matchPolicy,
    expandedTerms: requiredTerms,
    queries: queries.slice(0, 6),
    sourceTypes: [...sourceTypes],
    windowStart,
    windowEnd,
    maxCandidates,
  };
};

const validateDecisions = (
  seeds: TrendSeedClassificationInput[],
  decisions: TrendSeedDecision[],
): TrendSeedDecision[] => {
  if (!Array.isArray(decisions) || decisions.length !== seeds.length) {
    throw new TrendOrchestrationError('TREND_DECISION_INVALID', 'Trend classification response is invalid', false);
  }
  const seedsById = new Map(seeds.map((seed) => [seed.id, seed]));
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (
      typeof decision?.id !== 'string' || !seedsById.has(decision.id) || seen.has(decision.id) ||
      typeof decision.accepted !== 'boolean' || !Array.isArray(decision.requiredTerms)
    ) {
      throw new TrendOrchestrationError('TREND_DECISION_INVALID', 'Trend classification response is invalid', false);
    }
    seen.add(decision.id);
    if (!decision.accepted) {
      if (decision.query !== null || decision.requiredTerms.length !== 0) {
        throw new TrendOrchestrationError('TREND_DECISION_INVALID', 'Trend classification response is invalid', false);
      }
      continue;
    }
    if (typeof decision.query !== 'string' || !decision.query.trim() || decision.requiredTerms.length === 0) {
      throw new TrendOrchestrationError('TREND_DECISION_INVALID', 'Trend classification response is invalid', false);
    }
    try {
      buildRequiredKeywordPolicy(decision.requiredTerms, decision.query);
    } catch {
      throw new TrendOrchestrationError('TREND_DECISION_INVALID', 'Trend classification response is invalid', false);
    }
  }
  return decisions;
};

const nextAutomaticRun = (finishedAt: Date, intervalHours: number): Date =>
  new Date(finishedAt.getTime() + intervalHours * HOUR_MS);

export class PrismaTrendRepository implements TrendRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly runLeaseMs: number,
  ) {}

  async claimRun(
    userId: string,
    trigger: DiscoveryTrigger,
    startedAt: Date,
  ): Promise<TrendRunClaim> {
    return this.prisma.$transaction(async (transaction) => {
      const monitor = await transaction.trendMonitor.findUnique({ where: { userId } });
      if (!monitor) return { state: 'missing' } as const;
      const active = monitor.activeRunId !== null &&
        monitor.runLeaseUntil !== null && monitor.runLeaseUntil > startedAt;
      if (active) {
        if (trigger === 'scheduled' && monitor.runStatus === 'queued') {
          const leaseUntil = new Date(startedAt.getTime() + this.runLeaseMs);
          const claimed = await transaction.trendMonitor.updateMany({
            where: {
              id: monitor.id,
              userId,
              activeRunId: monitor.activeRunId,
              runStatus: 'queued',
              runLeaseUntil: monitor.runLeaseUntil,
            },
            data: { runStatus: 'running', runLeaseUntil: leaseUntil, lastError: Prisma.DbNull },
          });
          if (claimed.count === 1) {
            await transaction.trendRun.updateMany({
              where: { id: monitor.activeRunId!, userId, status: 'queued' },
              data: { status: 'running', startedAt },
            });
            return {
              state: 'claimed', runId: monitor.activeRunId!, monitorId: monitor.id,
              intervalHours: monitor.intervalHours, nextRunAt: monitor.nextRunAt,
            } as const;
          }
        }
        if (trigger !== 'manual' || monitor.manualRefreshPending) {
          return { state: 'active', followUpManualRegistered: false } as const;
        }
        const pending = await transaction.trendMonitor.updateMany({
          where: {
            id: monitor.id, userId, activeRunId: monitor.activeRunId,
            runLeaseUntil: { gt: startedAt }, manualRefreshPending: false,
          },
          data: { manualRefreshPending: true },
        });
        return { state: 'active', followUpManualRegistered: pending.count === 1 } as const;
      }

      if (monitor.activeRunId !== null) {
        await transaction.trendRun.updateMany({
          where: { id: monitor.activeRunId, userId, status: { in: ['queued', 'running'] } },
          data: {
            status: 'failed', finishedAt: startedAt,
            error: { code: 'TREND_RUN_LEASE_EXPIRED', message: 'Trend run lease expired' },
          },
        });
      }
      const runId = randomUUID();
      const leaseUntil = new Date(startedAt.getTime() + this.runLeaseMs);
      const claimed = await transaction.trendMonitor.updateMany({
        where: {
          id: monitor.id, userId,
          OR: [
            { activeRunId: null },
            { runLeaseUntil: null },
            { runLeaseUntil: { lte: startedAt } },
          ],
        },
        data: {
          activeRunId: runId, runStatus: 'running', runLeaseUntil: leaseUntil,
          manualRefreshPending: false, lastError: Prisma.DbNull,
        },
      });
      if (claimed.count !== 1) return { state: 'active', followUpManualRegistered: false } as const;
      await transaction.trendRun.create({
        data: { id: runId, userId, monitorId: monitor.id, trigger, status: 'running', startedAt },
      });
      return {
        state: 'claimed', runId, monitorId: monitor.id,
        intervalHours: monitor.intervalHours, nextRunAt: monitor.nextRunAt,
      } as const;
    });
  }

  async listRecentFingerprints(
    userId: string,
    fingerprints: string[],
    discoveredSince: Date,
  ): Promise<Set<string>> {
    if (fingerprints.length === 0) return new Set();
    const rows = await this.prisma.trendSeed.findMany({
      where: { userId, fingerprint: { in: fingerprints }, discoveredAt: { gte: discoveredSince } },
      select: { fingerprint: true },
    });
    return new Set(rows.map(({ fingerprint }) => fingerprint));
  }

  async saveSeeds(input: { runId: string; userId: string; seeds: SanitizedTrendSeed[] }): Promise<void> {
    if (input.seeds.length === 0) return;
    await this.prisma.trendSeed.createMany({
      data: input.seeds.map((seed) => ({
        userId: input.userId, runId: input.runId, sourceId: seed.sourceId,
        platform: seed.platform, externalId: seed.externalId, title: seed.title,
        sourceUrl: seed.sourceUrl, fingerprint: seed.fingerprint,
        publishedAt: seed.publishedAt, normalizedQuery: seed.normalizedQuery,
      })),
    });
  }

  async listHistoryUrls(userId: string): Promise<string[]> {
    const rows = await this.prisma.radarItem.findMany({
      where: { userId }, select: { canonicalPrimaryUrl: true },
    });
    return rows.map(({ canonicalPrimaryUrl }) => canonicalPrimaryUrl);
  }

  async completeSuccess(input: CompleteTrendRunInput): Promise<{
    newItemCount: number;
    followUpManual: boolean;
  }> {
    return this.prisma.$transaction(async (transaction) => {
      const ownership = await transaction.trendMonitor.updateMany({
        where: {
          id: input.monitorId, userId: input.userId, activeRunId: input.runId,
          runLeaseUntil: { gt: input.finishedAt },
        },
        data: { activeRunId: input.runId },
      });
      if (ownership.count !== 1) {
        throw new TrendOrchestrationError('TREND_RUN_LEASE_LOST', 'Trend run lease was lost', true);
      }
      const monitor = await transaction.trendMonitor.findUnique({
        where: { userId: input.userId },
        select: { manualRefreshPending: true, intervalHours: true, nextRunAt: true },
      });
      if (!monitor) throw new TrendOrchestrationError('TREND_MONITOR_MISSING', 'Trend monitor was not found', false);
      const rows = input.items.flatMap((candidate) => {
        let sourceUrls: string[];
        try {
          sourceUrls = unique(candidate.sourceUrls.map(canonicalizeUrl));
        } catch {
          return [];
        }
        const canonicalPrimaryUrl = sourceUrls[0];
        if (!canonicalPrimaryUrl) return [];
        return [{
          userId: input.userId, runId: input.runId, kind: candidate.kind,
          title: candidate.title, summary: candidate.summary, reason: candidate.reason,
          sourceUrls, canonicalPrimaryUrl,
          publishedAt: candidate.publishedAt ? new Date(candidate.publishedAt) : null,
          sourceType: candidate.sourceType, platform: candidate.platform,
          authorName: candidate.authorName, authorHandle: candidate.authorHandle,
          externalId: candidate.externalId, provenanceKind: candidate.provenanceKind,
        }];
      });
      const inserted = rows.length === 0
        ? { count: 0 }
        : await transaction.radarItem.createMany({ data: rows, skipDuplicates: true });
      await transaction.trendRun.update({
        where: { id_userId: { id: input.runId, userId: input.userId } },
        data: {
          status: 'succeeded', finishedAt: input.finishedAt,
          candidateCount: input.candidateCount, acceptedCount: input.acceptedCount,
          newItemCount: inserted.count, error: Prisma.DbNull,
        },
      });
      const followUpManual = monitor.manualRefreshPending;
      await transaction.trendMonitor.update({
        where: { id_userId: { id: input.monitorId, userId: input.userId } },
        data: {
          runStatus: followUpManual ? 'queued' : 'succeeded', activeRunId: null,
          runLeaseUntil: null, manualRefreshPending: false, lastError: Prisma.DbNull,
          ...(input.trigger === 'manual'
            ? {}
            : { nextRunAt: nextAutomaticRun(input.finishedAt, monitor.intervalHours) }),
        },
      });
      return { newItemCount: inserted.count, followUpManual };
    });
  }

  async completeFailure(input: {
    runId: string;
    monitorId: string;
    userId: string;
    trigger: DiscoveryTrigger;
    error: SafeError;
    finishedAt: Date;
    status: 'queued' | 'failed';
  }): Promise<{ followUpManual: boolean }> {
    return this.prisma.$transaction(async (transaction) => {
      const ownership = await transaction.trendMonitor.updateMany({
        where: {
          id: input.monitorId,
          userId: input.userId,
          activeRunId: input.runId,
          runLeaseUntil: { gt: input.finishedAt },
        },
        data: { activeRunId: input.runId },
      });
      if (ownership.count !== 1) return { followUpManual: false };
      const monitor = await transaction.trendMonitor.findUnique({
        where: { userId: input.userId },
        select: { manualRefreshPending: true, intervalHours: true },
      });
      if (!monitor) return { followUpManual: false };
      await transaction.trendRun.update({
        where: { id_userId: { id: input.runId, userId: input.userId } },
        data: { status: input.status, finishedAt: input.finishedAt, error: input.error },
      });
      const followUpManual = input.status === 'failed' && monitor.manualRefreshPending;
      await transaction.trendMonitor.update({
        where: { id_userId: { id: input.monitorId, userId: input.userId } },
        data: {
          runStatus: followUpManual ? 'queued' : input.status,
          activeRunId: null, runLeaseUntil: null,
          manualRefreshPending: input.status === 'queued' ? monitor.manualRefreshPending : false,
          lastError: input.error,
          ...(input.status === 'failed' && input.trigger !== 'manual'
            ? { nextRunAt: nextAutomaticRun(input.finishedAt, monitor.intervalHours) }
            : {}),
        },
      });
      return { followUpManual };
    });
  }
}

export class TrendOrchestrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TrendOrchestrationError';
  }
}

interface TrendSourceRegistryLike {
  collect(window: TrendWindow, signal?: AbortSignal): Promise<TrendCollectionSummary>;
}

interface ConnectorRegistryLike {
  search(plan: SourceQueryPlan, signal?: AbortSignal): Promise<ConnectorSearchSummary>;
}

interface QualityPipelineLike {
  run(input: QualityPipelineInput): Promise<DiscoveryCandidate[]>;
}

export interface TrendDiscoveryServiceOptions {
  repository: TrendRepository;
  trendSources: TrendSourceRegistryLike;
  gateway: Pick<AiGateway, 'classifyTrendSeeds'>;
  connectors: ConnectorRegistryLike;
  qualityPipeline: QualityPipelineLike;
  now?: () => Date;
  timeoutMs?: number;
  maxSeeds?: number;
  trendRequestBudget?: number;
  connectorCandidateBudget?: number;
}

export class TrendDiscoveryService {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maxSeeds: number;
  private readonly trendRequestBudget: number;
  private readonly connectorCandidateBudget: number;

  constructor(private readonly options: TrendDiscoveryServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.maxSeeds = options.maxSeeds ?? 60;
    this.trendRequestBudget = options.trendRequestBudget ?? 30;
    this.connectorCandidateBudget = options.connectorCandidateBudget ?? 60;
  }

  async run(
    userId: string,
    trigger: DiscoveryTrigger,
    context: { finalAttempt: boolean } = { finalAttempt: true },
  ): Promise<{ followUpManual: boolean }> {
    const startedAt = this.now();
    const claim = await this.options.repository.claimRun(userId, trigger, startedAt);
    if (claim.state !== 'claimed') return { followUpManual: false };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const windowEnd = this.now();
      const windowStart = new Date(windowEnd.getTime() - RECENT_SEED_MS);
      const collection = await this.options.trendSources.collect({
        windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
        maxCandidates: this.maxSeeds, requestBudget: this.trendRequestBudget,
      }, controller.signal);
      this.throwIfAborted(controller.signal);
      if (collection.successfulSourceIds.length === 0) {
        throw new TrendOrchestrationError(
          'ALL_TREND_SOURCES_FAILED',
          'All configured trend sources failed',
          collection.failures.some(({ retryable }) => retryable),
        );
      }
      const sanitized = collection.candidates.map(sanitizeSeed);
      const recent = await this.options.repository.listRecentFingerprints(
        userId, sanitized.map(({ fingerprint }) => fingerprint), windowStart,
      );
      const unseen = sanitized.filter(({ fingerprint }) => !recent.has(fingerprint));
      const classificationInputs: TrendSeedClassificationInput[] = unseen.map((candidate) => ({
        id: candidate.fingerprint, title: candidate.title,
        platform: candidate.platform, sourceUrl: candidate.sourceUrl,
      }));
      const decisions: TrendSeedDecision[] = [];
      for (let offset = 0; offset < classificationInputs.length; offset += CLASSIFICATION_BATCH_SIZE) {
        this.throwIfAborted(controller.signal);
        const batch = classificationInputs.slice(offset, offset + CLASSIFICATION_BATCH_SIZE);
        const raw = await this.options.gateway.classifyTrendSeeds({ seeds: batch, signal: controller.signal });
        decisions.push(...validateDecisions(batch, raw));
      }
      const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
      const seeds: SanitizedTrendSeed[] = unseen.map((candidate) => ({
        ...candidate,
        normalizedQuery: decisionById.get(candidate.fingerprint)?.query?.trim() ?? null,
      }));
      await this.options.repository.saveSeeds({ runId: claim.runId, userId, seeds });

      const accepted = decisions.filter((decision) => decision.accepted);
      const historyUrls = await this.options.repository.listHistoryUrls(userId);
      const items: DiscoveryCandidate[] = [];
      let anyConnectorSucceeded = false;
      const perSeedBudget = accepted.length === 0
        ? 0
        : Math.max(1, Math.floor(this.connectorCandidateBudget / accepted.length));
      for (const decision of accepted) {
        this.throwIfAborted(controller.signal);
        const plan = buildTrendPlan(
          decision, windowStart.toISOString(), windowEnd.toISOString(), perSeedBudget,
        );
        const connectorResult = await this.options.connectors.search(plan, controller.signal);
        if (connectorResult.successfulConnectorIds.length > 0) anyConnectorSucceeded = true;
        if (connectorResult.successfulConnectorIds.length === 0 && connectorResult.failures.length > 0) {
          continue;
        }
        const acceptedItems = await this.options.qualityPipeline.run({
          keyword: plan.keyword, matchPolicy: plan.matchPolicy,
          candidates: connectorResult.candidates, historyUrls,
          windowStart: plan.windowStart, windowEnd: plan.windowEnd, signal: controller.signal,
        });
        items.push(...acceptedItems);
      }
      if (accepted.length > 0 && !anyConnectorSucceeded) {
        throw new TrendOrchestrationError(
          'ALL_TREND_CONNECTORS_FAILED',
          'All configured discovery sources failed for accepted trends',
          true,
        );
      }
      this.throwIfAborted(controller.signal);
      const result = await this.options.repository.completeSuccess({
        runId: claim.runId, monitorId: claim.monitorId, userId, trigger,
        candidateCount: unseen.length, acceptedCount: accepted.length,
        items, finishedAt: this.now(),
      });
      return { followUpManual: result.followUpManual };
    } catch (error) {
      const failure = controller.signal.aborted
        ? new TrendOrchestrationError('TREND_RUN_TIMEOUT', 'Trend run exceeded its time limit', true)
        : error;
      const completed = await this.options.repository.completeFailure({
        runId: claim.runId, monitorId: claim.monitorId, userId, trigger,
        error: safeError(failure), finishedAt: this.now(),
        status: context.finalAttempt ? 'failed' : 'queued',
      });
      if (completed.followUpManual && context.finalAttempt) {
        return { followUpManual: true };
      }
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new TrendOrchestrationError('TREND_RUN_TIMEOUT', 'Trend run exceeded its time limit', true);
    }
  }
}
