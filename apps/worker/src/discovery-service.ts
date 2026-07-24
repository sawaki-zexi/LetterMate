import {
  safeErrorSchema,
  topicSchema,
  type DiscoveryCandidate,
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
  markRunning(topicId: string): Promise<void>;
  saveSuccess(
    topicId: string,
    expandedTerms: string[],
    items: DiscoveryCandidate[],
    finishedAt: Date,
  ): Promise<void>;
  saveFailure(
    topicId: string,
    error: SafeError,
    finishedAt: Date,
    status: 'queued' | 'failed',
  ): Promise<void>;
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
    runStatus: topic.runStatus,
    lastError: parsedError.success ? parsedError.data : null,
  });
}

const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

export class PrismaDiscoveryRepository implements DiscoveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOwnedTopic(topicId: string, userId: string): Promise<Topic | null> {
    const topic = await this.prisma.topic.findFirst({ where: { id: topicId, userId } });
    return topic ? mapTopic(topic) : null;
  }

  async markRunning(topicId: string): Promise<void> {
    await this.prisma.topic.update({
      where: { id: topicId },
      data: { runStatus: 'running', lastError: Prisma.DbNull },
    });
  }

  async saveSuccess(
    topicId: string,
    expandedTerms: string[],
    items: DiscoveryCandidate[],
    finishedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      for (const item of items) {
        const sourceUrls = unique(item.sourceUrls.map(canonicalizeUrl));
        const canonicalPrimaryUrl = sourceUrls[0];
        if (!canonicalPrimaryUrl) continue;
        const data = {
          kind: item.kind,
          title: item.title,
          summary: item.summary,
          reason: item.reason,
          sourceUrls,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        } as const;
        await transaction.discoveryItem.upsert({
          where: { topicId_canonicalPrimaryUrl: { topicId, canonicalPrimaryUrl } },
          create: { topicId, canonicalPrimaryUrl, ...data },
          update: data,
        });
      }
      await transaction.topic.update({
        where: { id: topicId },
        data: {
          expandedTerms: unique(expandedTerms),
          runStatus: 'succeeded',
          lastRunAt: finishedAt,
          lastError: Prisma.DbNull,
        },
      });
    });
  }

  async saveFailure(
    topicId: string,
    error: SafeError,
    finishedAt: Date,
    status: 'queued' | 'failed',
  ): Promise<void> {
    await this.prisma.topic.update({
      where: { id: topicId },
      data: {
        runStatus: status,
        lastRunAt: finishedAt,
        lastError: error,
      },
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
