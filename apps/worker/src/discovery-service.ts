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
import { AiGatewayError, type AiGateway } from './ai-gateway.js';
import type { ConnectorSearchSummary, SourceQueryPlan } from './connectors/types.js';
import type { QualityPipelineInput } from './quality-pipeline.js';
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
  schedule?: TopicScheduleUpdate;
}

export interface SaveFailureInput {
  runId: string;
  topicId: string;
  error: SafeError;
  finishedAt: Date;
  status: 'queued' | 'failed';
  schedule?: TopicScheduleUpdate;
}

export interface DiscoveryRepository {
  findOwnedTopic(topicId: string, userId: string): Promise<Topic | null>;
  beginRun(topicId: string, trigger: DiscoveryTrigger, startedAt: Date): Promise<string | null>;
  listHistoryUrls(topicId: string): Promise<string[]>;
  getScheduleState(topicId: string): Promise<TopicScheduleState>;
  saveSuccess(input: SaveSuccessInput): Promise<{ newItemCount: number }>;
  saveFailure(input: SaveFailureInput): Promise<void>;
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

export class PrismaDiscoveryRepository implements DiscoveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOwnedTopic(topicId: string, userId: string): Promise<Topic | null> {
    const topic = await this.prisma.topic.findFirst({ where: { id: topicId, userId } });
    return topic ? mapTopic(topic) : null;
  }

  async beginRun(
    topicId: string,
    trigger: DiscoveryTrigger,
    startedAt: Date,
  ): Promise<string | null> {
    return this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.topic.updateMany({
        where: { id: topicId, runStatus: { not: 'running' } },
        data: { runStatus: 'running', lastError: Prisma.DbNull },
      });
      if (claimed.count === 0) return null;
      const run = await transaction.discoveryRun.create({
        data: { topicId, trigger, status: 'running', startedAt },
        select: { id: true },
      });
      return run.id;
    });
  }

  async listHistoryUrls(topicId: string): Promise<string[]> {
    const items = await this.prisma.discoveryItem.findMany({
      where: { topicId },
      select: { canonicalPrimaryUrl: true },
    });
    return items.map(({ canonicalPrimaryUrl }) => canonicalPrimaryUrl);
  }

  async getScheduleState(topicId: string): Promise<TopicScheduleState> {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId },
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

  async saveSuccess(input: SaveSuccessInput): Promise<{ newItemCount: number }> {
    return this.prisma.$transaction(async (transaction) => {
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
          runStatus: 'succeeded',
          lastRunAt: input.finishedAt,
          lastError: Prisma.DbNull,
          ...(input.schedule ?? {}),
        },
      });
      return { newItemCount };
    });
  }

  async saveFailure(input: SaveFailureInput): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.discoveryRun.update({
        where: { id: input.runId },
        data: {
          status: input.status,
          finishedAt: input.finishedAt,
          error: input.error,
        },
      });
      await transaction.topic.update({
        where: { id: input.topicId },
        data: {
          runStatus: input.status,
          lastRunAt: input.finishedAt,
          lastError: input.error,
          ...(input.schedule ?? {}),
        },
      });
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

export interface TopicDiscoveryServiceOptions {
  gateway: Pick<AiGateway, 'expandTopic'>;
  registry: ConnectorRegistryLike;
  qualityPipeline: QualityPipelineLike;
  repository: DiscoveryRepository;
  now?: () => Date;
  timeoutMs?: number;
}

export interface DiscoveryRunContext {
  finalAttempt: boolean;
}

const allSourceTypes: SourceQueryPlan['sourceTypes'] = [
  'web',
  'feed',
  'social',
  'video',
  'community',
  'code',
  'paper',
];

export class TopicDiscoveryService {
  private readonly gateway: Pick<AiGateway, 'expandTopic'>;
  private readonly registry: ConnectorRegistryLike;
  private readonly qualityPipeline: QualityPipelineLike;
  private readonly repository: DiscoveryRepository;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: TopicDiscoveryServiceOptions) {
    this.gateway = options.gateway;
    this.registry = options.registry;
    this.qualityPipeline = options.qualityPipeline;
    this.repository = options.repository;
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
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const expanded = await this.gateway.expandTopic({ keyword: topic.keyword });
      const expandedTerms = unique([...expanded.terms, ...expanded.searchQueries]);
      const windowEnd = this.now();
      const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1_000);
      const plan: SourceQueryPlan = {
        keyword: topic.keyword,
        expandedTerms: unique(expanded.terms),
        queries: unique(expanded.searchQueries),
        sourceTypes: [...allSourceTypes],
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        maxCandidates: 100,
      };
      const [connectorResult, historyUrls] = await Promise.all([
        this.registry.search(plan, controller.signal),
        this.repository.listHistoryUrls(topicId),
      ]);
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
        candidates: connectorResult.candidates,
        historyUrls,
        windowStart: plan.windowStart,
        windowEnd: plan.windowEnd,
        signal: controller.signal,
      });
      const finishedAt = this.now();
      const schedule = trigger === 'manual'
        ? undefined
        : calculateScheduleUpdate({
            topicId,
            trigger,
            newItemCount: items.length,
            state: await this.repository.getScheduleState(topicId),
            finishedAt,
          });
      await this.repository.saveSuccess({
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
        ...(schedule ? { schedule } : {}),
      });
    } catch (error) {
      const finishedAt = this.now();
      await this.repository.saveFailure({
        runId,
        topicId,
        error: toSafeAiError(error),
        finishedAt,
        status: context.finalAttempt ? 'failed' : 'queued',
        ...(context.finalAttempt && trigger === 'scheduled'
          ? { schedule: calculateFailureSchedule(finishedAt) }
          : {}),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
