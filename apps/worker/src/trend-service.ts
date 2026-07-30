import { createHash, randomUUID } from 'node:crypto';
import type {
  DiscoveryCandidate,
  TrendJobData,
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
import { TREND_CLASSIFICATION_MAX_SEEDS } from './ai-gateway.js';
import type { ConnectorSearchSummary, SourceQueryPlan } from './connectors/types.js';
import {
  buildRequiredKeywordPolicy,
  filterQueriesForPolicy,
} from './keyword-policy.js';
import type { QualityPipelineInput } from './quality-pipeline.js';
import type { TrendCollectionSummary, TrendSeedCandidate, TrendWindow } from './trends/types.js';

const HOUR_MS = 60 * 60 * 1_000;
const RECENT_SEED_MS = 24 * HOUR_MS;

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

export interface TrendSeedIdentities {
  sourceExternal: Set<string>;
  urls: Set<string>;
  titles: Set<string>;
}

export type TrendRunClaim = {
  state: 'claimed';
  runId: string;
  monitorId: string;
  intervalHours: number;
  nextRunAt: Date;
} | {
  state: 'active';
  followUpManualRunId: string | null;
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

export type LegacyTrendJobData = {
  userId: string;
  trigger: 'manual' | 'scheduled';
};

export type TrendExecutionJobData = TrendJobData | LegacyTrendJobData;

export interface TrendRepository {
  claimRun(job: TrendExecutionJobData, startedAt: Date): Promise<TrendRunClaim>;
  listRecentFingerprints(
    userId: string,
    fingerprints: string[],
    discoveredSince: Date,
    excludeRunId: string,
  ): Promise<Set<string>>;
  listRecentSeedIdentities?(input: {
    userId: string;
    seeds: Array<Pick<SanitizedTrendSeed, 'sourceId' | 'externalId' | 'sourceUrl' | 'title'>>;
    discoveredSince: Date;
    excludeRunId: string;
  }): Promise<TrendSeedIdentities>;
  saveSeeds(input: { runId: string; userId: string; seeds: SanitizedTrendSeed[] }): Promise<void>;
  updateSeedQueries(input: {
    runId: string;
    userId: string;
    decisions: Array<{ fingerprint: string; normalizedQuery: string | null }>;
  }): Promise<void>;
  listHistoryUrls(userId: string): Promise<string[]>;
  completeSuccess(input: CompleteTrendRunInput): Promise<{
    newItemCount: number;
    followUpManualRunId: string | null;
  }>;
  completeFailure(input: {
    runId: string;
    monitorId: string;
    userId: string;
    trigger: DiscoveryTrigger;
    error: SafeError;
    finishedAt: Date;
    status: 'queued' | 'failed';
  }): Promise<{ followUpManualRunId: string | null }>;
  acknowledgeManualFollowUp(userId: string, runId: string): Promise<boolean>;
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

const normalizedSeedTitle = (title: string): string => title.normalize('NFKC').trim().toLowerCase();
const sourceExternalIdentity = (sourceId: string, externalId: string | null): string | null => (
  externalId ? `${sourceId.trim().toLowerCase()}\u0000${externalId.trim().toLowerCase()}` : null
);

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
    _legacyMaxSeeds?: number,
  ) {}

  async claimRun(
    job: TrendExecutionJobData,
    startedAt: Date,
  ): Promise<TrendRunClaim> {
    return this.prisma.$transaction(async (transaction) => {
      const { userId, trigger } = job;
      const monitor = await transaction.trendMonitor.findUnique({ where: { userId } });
      if (!monitor) return { state: 'missing' } as const;

      const pendingFollowUpRunId = async (): Promise<string | null> => {
        if (!monitor.manualRefreshPending || monitor.activeRunId === null || monitor.runStatus !== 'queued') {
          return null;
        }
        const run = await transaction.trendRun.findUnique({
          where: { id_userId: { id: monitor.activeRunId, userId } },
          select: { trigger: true, status: true },
        });
        return run?.trigger === 'manual' && run.status === 'queued' ? monitor.activeRunId : null;
      };

      const manualRunId = job.trigger === 'manual' && 'runId' in job ? job.runId : null;
      if (job.trigger === 'manual' && manualRunId === null) {
        const active = monitor.activeRunId !== null && monitor.runLeaseUntil !== null &&
          monitor.runLeaseUntil > startedAt &&
          (monitor.runStatus === 'queued' || monitor.runStatus === 'running');
        if (active) return { state: 'active', followUpManualRunId: await pendingFollowUpRunId() } as const;
        const runId = randomUUID();
        const leaseUntil = new Date(startedAt.getTime() + this.runLeaseMs);
        const claimed = await transaction.trendMonitor.updateMany({
          where: {
            id: monitor.id, userId, activeRunId: null,
            runStatus: { in: ['queued', 'succeeded', 'failed'] },
            OR: [{ runLeaseUntil: null }, { runLeaseUntil: { lte: startedAt } }],
          },
          data: {
            runStatus: 'running', activeRunId: runId, runLeaseUntil: leaseUntil,
            manualRefreshPending: false, lastError: Prisma.DbNull,
          },
        });
        if (claimed.count !== 1) return { state: 'active', followUpManualRunId: null } as const;
        await transaction.trendRun.create({
          data: { id: runId, userId, monitorId: monitor.id, trigger: 'manual', status: 'running', startedAt },
        });
        return {
          state: 'claimed', runId, monitorId: monitor.id,
          intervalHours: monitor.intervalHours, nextRunAt: monitor.nextRunAt,
        } as const;
      }

      if (job.trigger === 'manual') {
        if (
          monitor.activeRunId !== manualRunId ||
          monitor.runStatus !== 'queued' ||
          monitor.runLeaseUntil === null ||
          monitor.runLeaseUntil <= startedAt
        ) {
          return { state: 'active', followUpManualRunId: await pendingFollowUpRunId() } as const;
        }
        const queuedRun = await transaction.trendRun.findUnique({
          where: { id_userId: { id: manualRunId!, userId } },
          select: { trigger: true, status: true },
        });
        if (queuedRun?.trigger !== 'manual' || queuedRun.status !== 'queued') {
          return { state: 'active', followUpManualRunId: await pendingFollowUpRunId() } as const;
        }
        const leaseUntil = new Date(startedAt.getTime() + this.runLeaseMs);
        const claimed = await transaction.trendMonitor.updateMany({
          where: {
            id: monitor.id, userId, activeRunId: manualRunId!, runStatus: 'queued',
            runLeaseUntil: monitor.runLeaseUntil,
          },
          data: {
            runStatus: 'running', runLeaseUntil: leaseUntil,
            manualRefreshPending: false, lastError: Prisma.DbNull,
          },
        });
        if (claimed.count !== 1) {
          return { state: 'active', followUpManualRunId: null } as const;
        }
        await transaction.trendRun.updateMany({
          where: { id: manualRunId!, userId, trigger: 'manual', status: 'queued' },
          data: { status: 'running', startedAt },
        });
        return {
          state: 'claimed', runId: manualRunId!, monitorId: monitor.id,
          intervalHours: monitor.intervalHours, nextRunAt: monitor.nextRunAt,
        } as const;
      }

      const hasDueAt = 'dueAt' in job;
      const legacyScheduled = !hasDueAt;
      const dueAt = hasDueAt ? new Date(job.dueAt) : monitor.nextRunAt;
      if (
        (!legacyScheduled && dueAt > startedAt) ||
        monitor.nextRunAt.getTime() !== dueAt.getTime() ||
        monitor.activeRunId !== null ||
        monitor.runStatus !== 'queued'
      ) {
        return { state: 'active', followUpManualRunId: await pendingFollowUpRunId() } as const;
      }
      const runId = randomUUID();
      const leaseUntil = new Date(startedAt.getTime() + this.runLeaseMs);
      const claimed = await transaction.trendMonitor.updateMany({
        where: {
          id: monitor.id, userId, nextRunAt: dueAt, activeRunId: null,
          runStatus: 'queued', runLeaseUntil: monitor.runLeaseUntil,
        },
        data: {
          activeRunId: runId, runStatus: 'running', runLeaseUntil: leaseUntil,
          lastError: Prisma.DbNull,
        },
      });
      if (claimed.count !== 1) return { state: 'active', followUpManualRunId: null } as const;
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
    excludeRunId: string,
  ): Promise<Set<string>> {
    if (fingerprints.length === 0) return new Set();
    const rows = await this.prisma.trendSeed.findMany({
      where: {
        userId,
        fingerprint: { in: fingerprints },
        discoveredAt: { gte: discoveredSince },
        runId: { not: excludeRunId },
      },
      select: { fingerprint: true },
    });
    return new Set(rows.map(({ fingerprint }) => fingerprint));
  }

  async listRecentSeedIdentities(input: {
    userId: string;
    seeds: Array<Pick<SanitizedTrendSeed, 'sourceId' | 'externalId' | 'sourceUrl' | 'title'>>;
    discoveredSince: Date;
    excludeRunId: string;
  }): Promise<TrendSeedIdentities> {
    const urls = input.seeds.map(({ sourceUrl }) => sourceUrl);
    const base = {
      userId: input.userId,
      discoveredAt: { gte: input.discoveredSince },
      runId: { not: input.excludeRunId },
    } as const;
    const [externalRows, urlRows, titleRows] = await Promise.all([
      this.prisma.trendSeed.findMany({
        where: { ...base, externalId: { not: null } },
        select: { sourceId: true, externalId: true },
      }),
      urls.length === 0 ? Promise.resolve([] as Array<{ sourceUrl: string }>) : this.prisma.trendSeed.findMany({
        where: { ...base, sourceUrl: { in: urls } }, select: { sourceUrl: true },
      }),
      this.prisma.trendSeed.findMany({ where: base, select: { title: true } }),
    ]);
    return {
      sourceExternal: new Set((externalRows as Array<{ sourceId: string; externalId: string | null }>).map(
        ({ sourceId, externalId }) => sourceExternalIdentity(sourceId, externalId),
      ).filter((value): value is string => value !== null)),
      urls: new Set((urlRows as Array<{ sourceUrl: string }>).map(({ sourceUrl }) => sourceUrl)),
      titles: new Set((titleRows as Array<{ title: string }>).map(({ title }) => normalizedSeedTitle(title))),
    };
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
      skipDuplicates: true,
    });
  }

  async updateSeedQueries(input: {
    runId: string;
    userId: string;
    decisions: Array<{ fingerprint: string; normalizedQuery: string | null }>;
  }): Promise<void> {
    for (const decision of input.decisions) {
      await this.prisma.trendSeed.updateMany({
        where: {
          runId: input.runId,
          userId: input.userId,
          fingerprint: decision.fingerprint,
        },
        data: { normalizedQuery: decision.normalizedQuery },
      });
    }
  }

  async listHistoryUrls(userId: string): Promise<string[]> {
    const rows = await this.prisma.radarItem.findMany({
      where: { userId }, select: { canonicalPrimaryUrl: true },
    });
    return rows.map(({ canonicalPrimaryUrl }) => canonicalPrimaryUrl);
  }

  async completeSuccess(input: CompleteTrendRunInput): Promise<{
    newItemCount: number;
    followUpManualRunId: string | null;
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
      const followUpManualRunId = monitor.manualRefreshPending ? randomUUID() : null;
      if (followUpManualRunId) {
        await transaction.trendRun.create({
          data: {
            id: followUpManualRunId, userId: input.userId, monitorId: input.monitorId,
            trigger: 'manual', status: 'queued', startedAt: input.finishedAt,
          },
        });
      }
      await transaction.trendMonitor.update({
        where: { id_userId: { id: input.monitorId, userId: input.userId } },
        data: {
          runStatus: followUpManualRunId ? 'queued' : 'succeeded',
          activeRunId: followUpManualRunId,
          runLeaseUntil: followUpManualRunId
            ? new Date(input.finishedAt.getTime() + this.runLeaseMs)
            : null,
          manualRefreshPending: followUpManualRunId !== null, lastError: Prisma.DbNull,
          ...(input.trigger === 'manual'
            ? {}
            : { nextRunAt: nextAutomaticRun(input.finishedAt, monitor.intervalHours) }),
        },
      });
      return { newItemCount: inserted.count, followUpManualRunId };
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
  }): Promise<{ followUpManualRunId: string | null }> {
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
      if (ownership.count !== 1) return { followUpManualRunId: null };
      const monitor = await transaction.trendMonitor.findUnique({
        where: { userId: input.userId },
        select: { manualRefreshPending: true, intervalHours: true },
      });
      if (!monitor) return { followUpManualRunId: null };
      await transaction.trendRun.update({
        where: { id_userId: { id: input.runId, userId: input.userId } },
        data: { status: input.status, finishedAt: input.finishedAt, error: input.error },
      });
      const followUpManualRunId = input.status === 'failed' && monitor.manualRefreshPending
        ? randomUUID()
        : null;
      if (followUpManualRunId) {
        await transaction.trendRun.create({
          data: {
            id: followUpManualRunId, userId: input.userId, monitorId: input.monitorId,
            trigger: 'manual', status: 'queued', startedAt: input.finishedAt,
          },
        });
      }
      await transaction.trendMonitor.update({
        where: { id_userId: { id: input.monitorId, userId: input.userId } },
        data: input.status === 'queued'
          ? {
              runStatus: 'queued',
              activeRunId: input.runId,
              manualRefreshPending: monitor.manualRefreshPending,
              lastError: input.error,
            }
          : {
              runStatus: followUpManualRunId ? 'queued' : 'failed',
              activeRunId: followUpManualRunId,
              runLeaseUntil: followUpManualRunId
                ? new Date(input.finishedAt.getTime() + this.runLeaseMs)
                : null,
              manualRefreshPending: followUpManualRunId !== null,
              lastError: input.error,
              ...(input.trigger !== 'manual'
                ? { nextRunAt: nextAutomaticRun(input.finishedAt, monitor.intervalHours) }
                : {}),
            },
      });
      return { followUpManualRunId };
    });
  }

  async acknowledgeManualFollowUp(userId: string, runId: string): Promise<boolean> {
    const updated = await this.prisma.trendMonitor.updateMany({
      where: {
        userId,
        runStatus: 'queued',
        activeRunId: runId,
        manualRefreshPending: true,
      },
      data: { manualRefreshPending: false },
    });
    return updated.count === 1;
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
    job: TrendExecutionJobData,
    context: { finalAttempt: boolean } = { finalAttempt: true },
  ): Promise<{ followUpManualRunId: string | null }> {
    const { userId, trigger } = job;
    const startedAt = this.now();
    const claim = await this.options.repository.claimRun(job, startedAt);
    if (claim.state !== 'claimed') {
      return {
        followUpManualRunId: claim.state === 'active' ? claim.followUpManualRunId : null,
      };
    }
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
      const recent = this.options.repository.listRecentSeedIdentities
        ? await this.options.repository.listRecentSeedIdentities({
            userId, seeds: sanitized, discoveredSince: windowStart, excludeRunId: claim.runId,
          })
        : {
            sourceExternal: new Set<string>(), urls: new Set<string>(), titles: new Set<string>(),
          };
      const recentFingerprints = this.options.repository.listRecentSeedIdentities
        ? null
        : await this.options.repository.listRecentFingerprints(
            userId, sanitized.map(({ fingerprint }) => fingerprint), windowStart, claim.runId,
          );
      const seenSourceExternal = new Set(recent.sourceExternal);
      const seenUrls = new Set(recent.urls);
      const seenTitles = new Set(recent.titles);
      const unseen = sanitized.filter((candidate) => {
        if (recentFingerprints?.has(candidate.fingerprint)) return false;
        const sourceExternal = sourceExternalIdentity(
          candidate.sourceId, candidate.externalId,
        );
        const title = normalizedSeedTitle(candidate.title);
        if (
          (sourceExternal !== null && seenSourceExternal.has(sourceExternal))
          || seenUrls.has(candidate.sourceUrl)
          || seenTitles.has(title)
        ) return false;
        if (sourceExternal !== null) seenSourceExternal.add(sourceExternal);
        seenUrls.add(candidate.sourceUrl);
        seenTitles.add(title);
        return true;
      });
      const seeds: SanitizedTrendSeed[] = unseen.map((candidate) => ({
        ...candidate,
        normalizedQuery: null,
      }));
      await this.options.repository.saveSeeds({ runId: claim.runId, userId, seeds });
      const classificationInputs: TrendSeedClassificationInput[] = unseen.map((candidate) => ({
        id: candidate.fingerprint, title: candidate.title,
        platform: candidate.platform, sourceUrl: candidate.sourceUrl,
      }));
      const decisions: TrendSeedDecision[] = [];
      for (
        let offset = 0;
        offset < classificationInputs.length;
        offset += TREND_CLASSIFICATION_MAX_SEEDS
      ) {
        this.throwIfAborted(controller.signal);
        const batch = classificationInputs.slice(offset, offset + TREND_CLASSIFICATION_MAX_SEEDS);
        const raw = await this.options.gateway.classifyTrendSeeds({ seeds: batch, signal: controller.signal });
        decisions.push(...validateDecisions(batch, raw));
      }
      const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
      await this.options.repository.updateSeedQueries({
        runId: claim.runId,
        userId,
        decisions: unseen.map((candidate) => ({
          fingerprint: candidate.fingerprint,
          normalizedQuery: decisionById.get(candidate.fingerprint)?.query?.trim() ?? null,
        })),
      });

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
      return { followUpManualRunId: result.followUpManualRunId };
    } catch (error) {
      const failure = controller.signal.aborted
        ? new TrendOrchestrationError('TREND_RUN_TIMEOUT', 'Trend run exceeded its time limit', true)
        : error;
      const completed = await this.options.repository.completeFailure({
        runId: claim.runId, monitorId: claim.monitorId, userId, trigger,
        error: safeError(failure), finishedAt: this.now(),
        status: context.finalAttempt ? 'failed' : 'queued',
      });
      if (completed.followUpManualRunId && context.finalAttempt) {
        return { followUpManualRunId: completed.followUpManualRunId };
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

  async acknowledgeManualFollowUp(userId: string, runId: string): Promise<boolean> {
    return this.options.repository.acknowledgeManualFollowUp(userId, runId);
  }
}
