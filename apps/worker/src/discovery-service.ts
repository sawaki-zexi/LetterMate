import {
  safeErrorSchema,
  topicSchema,
  type DiscoveryCandidate,
  type DiscoveryTrigger,
  type SafeError,
  type Topic,
} from '@lettermate/contracts';
import {
  DiscoveryValidationError,
  canonicalizeUrl,
  validateDiscoveryResult,
} from '@lettermate/domain';
import {
  Prisma,
  type Topic as PrismaTopic,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { AiGatewayError, type AiGateway } from './ai-gateway.js';

export interface DiscoveryRepository {
  findOwnedTopic(topicId: string, userId: string): Promise<Topic | null>;
  beginRun(topicId: string, trigger: DiscoveryTrigger, startedAt: Date): Promise<string>;
  listHistoryUrls(topicId: string): Promise<string[]>;
  saveSuccess(input: SaveSuccessInput): Promise<{ newItemCount: number }>;
  saveFailure(input: SaveFailureInput): Promise<void>;
}

export interface SafeConnectorRunSummary {
  successfulConnectorIds: string[];
  skippedConnectorIds: string[];
  failures: Array<{ connectorId: string; code: string; retryable: boolean }>;
}

export interface TopicScheduleUpdate {
  nextRunAt: Date;
  scheduleIntervalHours: 6 | 12 | 24;
  productiveRunStreak: number;
  emptyRunStreak: number;
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

const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

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
  ): Promise<string> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.topic.update({
        where: { id: topicId },
        data: { runStatus: 'running', lastError: Prisma.DbNull },
      });
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
            topicId_canonicalPrimaryUrl: {
              topicId: input.topicId,
              canonicalPrimaryUrl,
            },
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

export function toSafeAiError(error: unknown): SafeError {
  if (error instanceof AiGatewayError || error instanceof DiscoveryValidationError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'AI_UPSTREAM_UNAVAILABLE',
    message: 'AI 发现任务暂时不可用',
  };
}

export class TopicDiscoveryService {
  constructor(
    private readonly gateway: AiGateway,
    private readonly repository: DiscoveryRepository,
    private readonly now = () => new Date(),
  ) {}

  async run(topicId: string, userId: string): Promise<void> {
    const topic = await this.repository.findOwnedTopic(topicId, userId);
    if (!topic) return;

    await this.repository.markRunning(topicId);
    try {
      const expanded = await this.gateway.expandTopic({ keyword: topic.keyword });
      const expandedTerms = unique([...expanded.terms, ...expanded.searchQueries]);
      const result = await this.gateway.discover({
        keyword: topic.keyword,
        expandedTerms,
        lookbackDays: 7,
        now: this.now().toISOString(),
      });
      const items = validateDiscoveryResult(result);
      await this.repository.saveSuccess(topicId, expandedTerms, items, this.now());
    } catch (error) {
      await this.repository.saveFailure(topicId, toSafeAiError(error), this.now(), 'failed');
      throw error;
    }
  }
}
