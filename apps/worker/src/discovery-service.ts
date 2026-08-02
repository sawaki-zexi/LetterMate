import {
  safeErrorSchema,
  topicSchema,
  type DiscoveryCandidate,
  type DiscoveryTrigger,
  type SafeError,
  type Topic,
} from '@lettermate/contracts';
import { canonicalizeUrl } from '@lettermate/domain';
import { Prisma, type Topic as PrismaTopic } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AiGatewayError, type AiGateway } from './ai-gateway.js';
import type { ConnectorSearchSummary, SourceQueryPlan } from './connectors/types.js';
import { buildKeywordPolicy } from './keyword-policy.js';
import type { QualityPipelineInput } from './quality-pipeline.js';
import { SourceRouter } from './source-router.js';
import {
  calculateFailureSchedule,
  calculateScheduleUpdate,
  type TopicScheduleState,
  type TopicScheduleUpdate,
} from './scheduler.js';

export interface SafeConnectorRunSummary {
  successfulConnectorIds: string[];
  skippedConnectorIds: string[];
  failures: Array<{ connectorId: string; code: string; retryable: boolean }>;
}

export interface SaveSuccessInput {
  runId: string;
  topicId: string;
  trigger: DiscoveryTrigger;
  expandedTerms: string[];
  items: DiscoveryCandidate[];
  connectorSummary: SafeConnectorRunSummary;
  candidateCount: number;
  acceptedCount: number;
  finishedAt: Date;
  persistenceTimeoutMs: number;
  schedule?: TopicScheduleUpdate;
}

export interface SaveFailureInput {
  runId: string;
  topicId: string;
  error: SafeError;
  finishedAt: Date;
  status: 'queued' | 'failed';
  trigger?: DiscoveryTrigger;
  schedule?: TopicScheduleUpdate;
}

export interface DiscoveryRepository {
  findOwnedTopic(topicId: string, userId: string): Promise<Topic | null>;
  beginRun(topicId: string, trigger: DiscoveryTrigger, startedAt: Date): Promise<string | null>;
  listHistoryUrls(topicId: string): Promise<string[]>;
  getScheduleState(topicId: string): Promise<TopicScheduleState>;
  saveSuccess(input: SaveSuccessInput): Promise<{
    newItemCount: number;
    pendingManualRefresh: boolean;
  }>;
  saveFailure(input: SaveFailureInput): Promise<{ pendingManualRefresh: boolean }>;
}

function mapTopic(topic: PrismaTopic): Topic {
  const parsedError = safeErrorSchema.safeParse(topic.lastError);
  return topicSchema.parse({
    id: topic.id,
    userId: topic.userId,
    keyword: topic.keyword,
    expandedTerms: topic.expandedTerms,
    createdAt: topic.createdAt.toISOString(),
    lastRunAt: topic.lastRunAt?.toISOString() ?? null,
    nextRunAt: topic.nextRunAt?.toISOString() ?? null,
    scheduleIntervalHours: topic.scheduleIntervalHours,
    runStatus: topic.runStatus,
    lastError: parsedError.success ? parsedError.data : null,
    lastRun: null,
  });
}

const unique = (values: string[]) => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

const safeConnectorSummary = (summary: SafeConnectorRunSummary) => ({
  successfulConnectorIds: unique(summary.successfulConnectorIds),
  skippedConnectorIds: unique(summary.skippedConnectorIds),
  failures: summary.failures.map(({ connectorId, code, retryable }) => ({
    connectorId,
    code,
    retryable,
  })),
});

function persistenceTransactionOptions(persistenceTimeoutMs: number) {
  const budgetMs = Math.floor(persistenceTimeoutMs);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error('Persistence transaction requires a positive timeout budget');
  }
  const maxWait = Math.min(1_000, Math.floor(budgetMs / 4));
  return {
    maxWait,
    timeout: Math.max(1, budgetMs - maxWait),
  };
}

function isPrismaTransactionTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2028';
}

export class PrismaDiscoveryRepository implements DiscoveryRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly runLeaseMs = 20 * 60 * 1_000,
  ) {}

  async findOwnedTopic(topicId: string, userId: string): Promise<Topic | null> {
    const topic = await this.prisma.topic.findFirst({ where: { id: topicId, userId, deletedAt: null } });
    return topic ? mapTopic(topic) : null;
  }

  async beginRun(
    topicId: string,
    trigger: DiscoveryTrigger,
    startedAt: Date,
  ): Promise<string | null> {
    return this.prisma.$transaction(async (transaction) => {
      const previous = await transaction.topic.findFirst({
        where: { id: topicId, deletedAt: null },
        select: { activeRunId: true, runStatus: true, runLeaseUntil: true, keyword: true, expandedTerms: true },
      });
      if (!previous) return null;
      const runId = randomUUID();
      const claimed = await transaction.topic.updateMany({
        where: {
          id: topicId,
          deletedAt: null,
          activeRunId: previous.activeRunId,
          OR: [
            { runStatus: { not: 'running' } },
            { runLeaseUntil: null },
            { runLeaseUntil: { lte: startedAt } },
          ],
        },
        data: {
          runStatus: 'running',
          queuedTrigger: null,
          activeRunId: runId,
          runLeaseUntil: new Date(startedAt.getTime() + this.runLeaseMs),
          lastError: Prisma.DbNull,
          ...(trigger === 'manual' ? { manualRefreshPending: false } : {}),
        },
      });
      if (claimed.count === 0) return null;
      if (
        previous.activeRunId &&
        (
          previous.runStatus === 'running' ||
          previous.runLeaseUntil === null ||
          previous.runLeaseUntil <= startedAt
        )
      ) {
        await transaction.discoveryRun.updateMany({
          where: { id: previous.activeRunId, status: 'running' },
          data: {
            status: 'failed',
            finishedAt: startedAt,
            error: { code: 'RUN_LEASE_EXPIRED', message: 'Discovery run lease expired' },
          },
        });
      }
      const run = await transaction.discoveryRun.create({
        data: {
          id: runId, topicId, trigger, status: 'running', startedAt,
          keywordSnapshot: previous.keyword, expandedTermsSnapshot: previous.expandedTerms,
        },
        select: { id: true },
      });
      return run.id;
    });
  }

  async listHistoryUrls(topicId: string): Promise<string[]> {
    const items = await this.prisma.discoveryItem.findMany({
      where: { topicId },
      select: { sourceUrls: true },
    });
    return unique(items.flatMap(({ sourceUrls }) => sourceUrls.map(canonicalizeUrl)));
  }

  async getScheduleState(topicId: string): Promise<TopicScheduleState> {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, deletedAt: null },
      select: {
        scheduleIntervalHours: true,
        productiveRunStreak: true,
        emptyRunStreak: true,
      },
    });
    if (!topic) throw new Error('Topic schedule state was not found');
    if (
      topic.scheduleIntervalHours !== 6 &&
      topic.scheduleIntervalHours !== 12 &&
      topic.scheduleIntervalHours !== 24
    ) {
      throw new Error('Invalid topic schedule interval');
    }
    return {
      scheduleIntervalHours: topic.scheduleIntervalHours,
      productiveRunStreak: topic.productiveRunStreak,
      emptyRunStreak: topic.emptyRunStreak,
    };
  }

  async saveSuccess(input: SaveSuccessInput): Promise<{
    newItemCount: number;
    pendingManualRefresh: boolean;
  }> {
    return this.prisma.$transaction(async (transaction) => {
      const ownership = await transaction.topic.updateMany({
        where: {
          id: input.topicId,
          activeRunId: input.runId,
          runLeaseUntil: { gt: input.finishedAt },
        },
        data: { activeRunId: input.runId },
      });
      if (ownership.count === 0) {
        await transaction.discoveryRun.update({
          where: { id: input.runId },
          data: {
            status: 'failed',
            finishedAt: input.finishedAt,
            error: { code: 'RUN_LEASE_LOST', message: 'Discovery run lease was lost' },
          },
        });
        return { newItemCount: 0, pendingManualRefresh: false };
      }
      const topicState = await transaction.topic.findFirst({
        where: { id: input.topicId },
        select: { manualRefreshPending: true },
      });
      const run = await transaction.discoveryRun.findUnique({
        where: { id: input.runId },
        select: { keywordSnapshot: true },
      });
      if (!run) throw new Error('Discovery run was not found');
      const normalizedItems = input.items.flatMap((item) => {
        const sourceUrls = unique(item.sourceUrls.map(canonicalizeUrl));
        const canonicalPrimaryUrl = sourceUrls[0];
        return canonicalPrimaryUrl ? [{ item, sourceUrls, canonicalPrimaryUrl }] : [];
      });
      const existing = await transaction.discoveryItem.findMany({
        where: {
          topicId: input.topicId,
          canonicalPrimaryUrl: {
            in: normalizedItems.map(({ canonicalPrimaryUrl }) => canonicalPrimaryUrl),
          },
        },
        select: { canonicalPrimaryUrl: true },
      });
      const existingUrls = new Set(existing.map(({ canonicalPrimaryUrl }) => canonicalPrimaryUrl));
      const newItemCount = normalizedItems.filter(
        ({ canonicalPrimaryUrl }) => !existingUrls.has(canonicalPrimaryUrl),
      ).length;

      for (const { item, sourceUrls, canonicalPrimaryUrl } of normalizedItems) {
        const data = {
          kind: item.kind,
          title: item.title,
          summary: item.summary,
          reason: item.reason,
          sourceUrls,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
          sourceType: item.sourceType,
          platform: item.platform,
          authorName: item.authorName,
          authorHandle: item.authorHandle,
          externalId: item.externalId,
          provenanceKind: item.provenanceKind,
          topicKeyword: run.keywordSnapshot,
        } as const;
        await transaction.discoveryItem.upsert({
          where: {
            topicId_canonicalPrimaryUrl: { topicId: input.topicId, canonicalPrimaryUrl },
          },
          create: { topicId: input.topicId, canonicalPrimaryUrl, ...data },
          update: data,
        });
      }
      await transaction.discoveryRun.update({
        where: { id: input.runId },
        data: {
          status: 'succeeded',
          finishedAt: input.finishedAt,
          connectorSummary: safeConnectorSummary(input.connectorSummary),
          candidateCount: input.candidateCount,
          acceptedCount: input.acceptedCount,
          newItemCount,
          error: Prisma.DbNull,
        },
      });
      await transaction.topic.update({
        where: { id: input.topicId },
        data: {
          expandedTerms: unique(input.expandedTerms),
          runStatus: topicState?.manualRefreshPending ? 'queued' : 'succeeded',
          queuedTrigger: topicState?.manualRefreshPending ? 'manual' : null,
          lastRunAt: input.finishedAt,
          lastError: Prisma.DbNull,
          activeRunId: null,
          runLeaseUntil: null,
          ...(input.schedule ?? {}),
        },
      });
      return {
        newItemCount,
        pendingManualRefresh: topicState?.manualRefreshPending ?? false,
      };
    }, persistenceTransactionOptions(input.persistenceTimeoutMs));
  }

  async saveFailure(input: SaveFailureInput): Promise<{ pendingManualRefresh: boolean }> {
    return this.prisma.$transaction(async (transaction) => {
      const ownership = await transaction.topic.updateMany({
        where: {
          id: input.topicId,
          activeRunId: input.runId,
          runLeaseUntil: { gt: input.finishedAt },
        },
        data: { activeRunId: input.runId },
      });
      if (ownership.count === 0) return { pendingManualRefresh: false };
      await transaction.discoveryRun.update({
        where: { id: input.runId },
        data: {
          status: input.status,
          finishedAt: input.finishedAt,
          error: input.error,
        },
      });
      const topicState = await transaction.topic.findFirst({
        where: { id: input.topicId },
        select: { manualRefreshPending: true },
      });
      await transaction.topic.update({
        where: { id: input.topicId },
        data: {
          runStatus: topicState?.manualRefreshPending ? 'queued' : input.status,
          queuedTrigger: topicState?.manualRefreshPending
            ? 'manual'
            : input.status === 'queued' ? (input.trigger ?? 'scheduled') : null,
          lastRunAt: input.finishedAt,
          lastError: input.error,
          activeRunId: null,
          runLeaseUntil: null,
          ...(input.schedule ?? {}),
        },
      });
      return { pendingManualRefresh: topicState?.manualRefreshPending ?? false };
    });
  }
}

export class DiscoveryOrchestrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DiscoveryOrchestrationError';
  }
}

export function toSafeAiError(error: unknown): SafeError {
  if (error instanceof AiGatewayError || error instanceof DiscoveryOrchestrationError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'DISCOVERY_RUN_FAILED',
    message: 'Discovery is temporarily unavailable',
  };
}

interface ConnectorRegistryLike {
  search(plan: SourceQueryPlan, signal?: AbortSignal): Promise<ConnectorSearchSummary>;
}

interface QualityPipelineLike {
  run(input: QualityPipelineInput): Promise<DiscoveryCandidate[]>;
}

interface SourceRouterLike {
  route(input: {
    keyword: string;
    expanded: Awaited<ReturnType<AiGateway['expandTopic']>>;
    windowStart: string;
    windowEnd: string;
  }): SourceQueryPlan;
}

export interface TopicDiscoveryServiceOptions {
  gateway: Pick<AiGateway, 'expandTopic'>;
  registry: ConnectorRegistryLike;
  qualityPipeline: QualityPipelineLike;
  repository: DiscoveryRepository;
  router?: SourceRouterLike;
  now?: () => Date;
  timeoutMs?: number;
}

export interface DiscoveryRunContext {
  finalAttempt: boolean;
}

export class TopicDiscoveryService {
  private readonly gateway: Pick<AiGateway, 'expandTopic'>;
  private readonly registry: ConnectorRegistryLike;
  private readonly qualityPipeline: QualityPipelineLike;
  private readonly repository: DiscoveryRepository;
  private readonly router: SourceRouterLike;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: TopicDiscoveryServiceOptions) {
    this.gateway = options.gateway;
    this.registry = options.registry;
    this.qualityPipeline = options.qualityPipeline;
    this.repository = options.repository;
    this.router = options.router ?? new SourceRouter();
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 600_000;
  }

  async run(
    topicId: string,
    userId: string,
    trigger: DiscoveryTrigger,
    context: DiscoveryRunContext = { finalAttempt: true },
  ): Promise<void> {
    const topic = await this.repository.findOwnedTopic(topicId, userId);
    if (!topic) return;

    const startedAt = this.now();
    const runId = await this.repository.beginRun(topicId, trigger, startedAt);
    if (runId === null) return;
    const controller = new AbortController();
    const deadlineAt = Date.now() + this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let pendingManualRefresh = false;
    try {
      buildKeywordPolicy(topic.keyword);
      const expanded = await this.gateway.expandTopic({
        keyword: topic.keyword,
        signal: controller.signal,
      });
      this.throwIfTimedOut(controller.signal, deadlineAt);
      const expandedTerms = unique([...expanded.terms, ...expanded.searchQueries]);
      const windowEnd = this.now();
      const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1_000);
      const plan = this.router.route({
        keyword: topic.keyword,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        expanded,
      });
      const [connectorResult, historyUrls] = await Promise.all([
        this.registry.search(plan, controller.signal),
        this.repository.listHistoryUrls(topicId),
      ]);
      this.throwIfTimedOut(controller.signal, deadlineAt);
      if (
        connectorResult.successfulConnectorIds.length === 0 &&
        connectorResult.failures.length > 0
      ) {
        throw new DiscoveryOrchestrationError(
          'ALL_CONNECTORS_FAILED',
          'All configured discovery sources failed',
          connectorResult.failures.some((failure) => failure.retryable),
        );
      }
      const items = await this.qualityPipeline.run({
        keyword: topic.keyword,
        matchPolicy: plan.matchPolicy,
        candidates: connectorResult.candidates,
        historyUrls,
        windowStart: plan.windowStart,
        windowEnd: plan.windowEnd,
        signal: controller.signal,
      });
      this.throwIfTimedOut(controller.signal, deadlineAt);
      const scheduleState = trigger === 'manual'
        ? undefined
        : await this.repository.getScheduleState(topicId);
      this.throwIfTimedOut(controller.signal, deadlineAt);
      const finishedAt = this.now();
      const schedule = trigger === 'manual'
        ? undefined
        : calculateScheduleUpdate({
            topicId,
            trigger,
            newItemCount: items.length,
            state: scheduleState!,
            finishedAt,
          });
      this.throwIfTimedOut(controller.signal, deadlineAt);
      const persistenceTimeoutMs = this.remainingTimeMs(controller.signal, deadlineAt);
      const saved = await this.repository.saveSuccess({
        runId,
        topicId,
        trigger,
        expandedTerms,
        items,
        connectorSummary: {
          successfulConnectorIds: connectorResult.successfulConnectorIds,
          skippedConnectorIds: connectorResult.skippedConnectorIds,
          failures: connectorResult.failures.map(({ connectorId, code, retryable }) => ({
            connectorId,
            code,
            retryable,
          })),
        },
        candidateCount: connectorResult.candidates.length,
        acceptedCount: items.length,
        finishedAt,
        persistenceTimeoutMs,
        ...(schedule ? { schedule } : {}),
      });
      this.throwIfTimedOut(controller.signal, deadlineAt);
      pendingManualRefresh = saved.pendingManualRefresh;
    } catch (error) {
      const failure = this.isTimedOut(error, controller.signal, deadlineAt)
        ? new DiscoveryOrchestrationError(
            'DISCOVERY_RUN_TIMEOUT',
            'Discovery run exceeded its time limit',
            true,
          )
        : error;
      const finishedAt = this.now();
      const saved = await this.repository.saveFailure({
        runId,
        topicId,
        error: toSafeAiError(failure),
        finishedAt,
        status: context.finalAttempt ? 'failed' : 'queued',
        trigger,
        ...(context.finalAttempt && trigger === 'scheduled'
          ? { schedule: calculateFailureSchedule(finishedAt) }
          : {}),
      });
      if (saved.pendingManualRefresh && context.finalAttempt) {
        clearTimeout(timeout);
        try {
          await this.run(topicId, userId, 'manual', context);
        } catch {
          // The pending run persists its own safe failure state.
        }
      }
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
    if (pendingManualRefresh) {
      await this.run(topicId, userId, 'manual', context);
    }
  }

  private remainingTimeMs(signal: AbortSignal, deadlineAt: number): number {
    const remaining = deadlineAt - Date.now();
    if (signal.aborted || remaining <= 0) {
      throw new DiscoveryOrchestrationError(
        'DISCOVERY_RUN_TIMEOUT',
        'Discovery run exceeded its time limit',
        true,
      );
    }
    return remaining;
  }

  private isTimedOut(error: unknown, signal: AbortSignal, deadlineAt: number): boolean {
    return signal.aborted || Date.now() >= deadlineAt || isPrismaTransactionTimeout(error);
  }

  private throwIfTimedOut(signal: AbortSignal, deadlineAt: number): void {
    if (signal.aborted || Date.now() >= deadlineAt) {
      throw new DiscoveryOrchestrationError(
        'DISCOVERY_RUN_TIMEOUT',
        'Discovery run exceeded its time limit',
        true,
      );
    }
  }
}
