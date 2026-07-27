import {
  discoveryItemSchema,
  safeErrorSchema,
  topicSchema,
  type DiscoveryCandidate,
  type DiscoveryItem,
  type DiscoveryKind,
  type Topic,
} from '@lettermate/contracts';
import { canonicalizeUrl, normalizeKeyword } from '@lettermate/domain';
import {
  Prisma,
  type DiscoveryItem as PrismaDiscoveryItem,
  type Topic as PrismaTopic,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class TopicAlreadyExistsError extends Error {
  constructor() {
    super('Topic already exists');
    this.name = 'TopicAlreadyExistsError';
  }
}

export interface TopicStore {
  createTopic(userId: string, keyword: string, normalizedKeyword: string): Promise<Topic>;
  listTopics(userId: string): Promise<Topic[]>;
  findTopic(userId: string, id: string): Promise<Topic | null>;
  queueRefresh(userId: string, id: string): Promise<Topic | null>;
  listFeed(
    userId: string,
    filter: { topicId?: string; kind?: DiscoveryKind; since?: Date },
  ): Promise<DiscoveryItem[]>;
  findItem(userId: string, id: string): Promise<DiscoveryItem | null>;
  close(): Promise<void>;
}

function mapTopic(topic: PrismaTopic): Topic {
  const error = safeErrorSchema.safeParse(topic.lastError);
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
    lastError: error.success ? error.data : null,
  });
}

function mapItem(item: PrismaDiscoveryItem): DiscoveryItem {
  return discoveryItemSchema.parse({
    id: item.id,
    topicId: item.topicId,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    reason: item.reason,
    sourceUrls: item.sourceUrls,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    discoveredAt: item.discoveredAt.toISOString(),
    sourceType: item.sourceType,
    platform: item.platform,
    authorName: item.authorName,
    authorHandle: item.authorHandle,
    externalId: item.externalId,
    provenanceKind: item.provenanceKind,
  });
}

export class PrismaTopicStore implements TopicStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createTopic(
    userId: string,
    keyword: string,
    normalizedKeyword: string,
  ): Promise<Topic> {
    try {
      const topic = await this.prisma.topic.create({
        data: {
          keyword,
          normalizedKeyword,
          user: {
            connectOrCreate: {
              where: { id: userId },
              create: {
                id: userId,
                email: `${userId}@example.local`,
                passwordHash: 'local-prototype-no-login-credential',
                timezone: 'Asia/Shanghai',
              },
            },
          },
        },
      });
      return mapTopic(topic);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new TopicAlreadyExistsError();
      }
      throw error;
    }
  }

  async listTopics(userId: string): Promise<Topic[]> {
    const topics = await this.prisma.topic.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return topics.map(mapTopic);
  }

  async findTopic(userId: string, id: string): Promise<Topic | null> {
    const topic = await this.prisma.topic.findFirst({ where: { id, userId } });
    return topic ? mapTopic(topic) : null;
  }

  async queueRefresh(userId: string, id: string): Promise<Topic | null> {
    const owned = await this.prisma.topic.findFirst({ where: { id, userId }, select: { id: true } });
    if (!owned) return null;
    const topic = await this.prisma.topic.update({
      where: { id },
      data: { runStatus: 'queued', lastError: Prisma.DbNull },
    });
    return mapTopic(topic);
  }

  async listFeed(
    userId: string,
    filter: { topicId?: string; kind?: DiscoveryKind; since?: Date },
  ): Promise<DiscoveryItem[]> {
    const items = await this.prisma.discoveryItem.findMany({
      where: {
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.since ? {
          OR: [
            { publishedAt: { gte: filter.since } },
            { publishedAt: null, discoveredAt: { gte: filter.since } },
          ],
        } : {}),
        topic: {
          userId,
          ...(filter.topicId ? { id: filter.topicId } : {}),
        },
      },
      orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }],
    });
    return items.map(mapItem);
  }

  async findItem(userId: string, id: string): Promise<DiscoveryItem | null> {
    const item = await this.prisma.discoveryItem.findFirst({
      where: { id, topic: { userId } },
    });
    return item ? mapItem(item) : null;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

export class MemoryTopicStore implements TopicStore {
  private readonly topics: Topic[] = [];
  private readonly items: DiscoveryItem[] = [];

  async createTopic(
    userId: string,
    keyword: string,
    normalizedKeyword: string,
  ): Promise<Topic> {
    if (
      this.topics.some(
        (topic) =>
          topic.userId === userId && topic.keyword && normalizeKeyword(topic.keyword) === normalizedKeyword,
      )
    ) {
      throw new TopicAlreadyExistsError();
    }
    const topic: Topic = {
      id: randomUUID(),
      userId,
      keyword,
      expandedTerms: [],
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      scheduleIntervalHours: 12,
      runStatus: 'queued',
      lastError: null,
    };
    this.topics.unshift(topic);
    return structuredClone(topic);
  }

  async listTopics(userId: string): Promise<Topic[]> {
    return this.topics
      .filter((topic) => topic.userId === userId)
      .map((topic) => structuredClone(topic));
  }

  async findTopic(userId: string, id: string): Promise<Topic | null> {
    const topic = this.topics.find((candidate) => candidate.userId === userId && candidate.id === id);
    return topic ? structuredClone(topic) : null;
  }

  async queueRefresh(userId: string, id: string): Promise<Topic | null> {
    const topic = this.topics.find((candidate) => candidate.userId === userId && candidate.id === id);
    if (!topic) return null;
    topic.runStatus = 'queued';
    topic.lastError = null;
    return structuredClone(topic);
  }

  async listFeed(
    userId: string,
    filter: { topicId?: string; kind?: DiscoveryKind; since?: Date },
  ): Promise<DiscoveryItem[]> {
    const topicIds = new Set(
      this.topics.filter((topic) => topic.userId === userId).map((topic) => topic.id),
    );
    return this.items
      .filter(
        (item) =>
          topicIds.has(item.topicId) &&
          (!filter.topicId || item.topicId === filter.topicId) &&
          (!filter.kind || item.kind === filter.kind) &&
          (!filter.since || (item.publishedAt ?? item.discoveredAt) >= filter.since.toISOString()),
      )
      .sort((left, right) =>
        (right.publishedAt ?? right.discoveredAt).localeCompare(
          left.publishedAt ?? left.discoveredAt,
        ),
      )
      .map((item) => structuredClone(item));
  }

  async findItem(userId: string, id: string): Promise<DiscoveryItem | null> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return null;
    const ownsTopic = this.topics.some(
      (topic) => topic.id === item.topicId && topic.userId === userId,
    );
    return ownsTopic ? structuredClone(item) : null;
  }

  seedTopic(userId: string, keyword: string): Topic {
    const topic: Topic = {
      id: randomUUID(),
      userId,
      keyword,
      expandedTerms: [],
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      scheduleIntervalHours: 12,
      runStatus: 'succeeded',
      lastError: null,
    };
    this.topics.push(topic);
    return structuredClone(topic);
  }

  seedItem(
    topicId: string,
    kind: DiscoveryKind,
    timestamps: { publishedAt?: string | null; discoveredAt?: string } = {},
  ): DiscoveryItem {
    const id = randomUUID();
    const item: DiscoveryItem = {
      id,
      topicId,
      kind,
      title: kind === 'hot' ? '热点内容' : '优质内容',
      summary: '中文摘要',
      reason: kind === 'hot' ? '近期讨论集中' : '内容深入且可复现',
      sourceUrls: [`https://example.com/${id}`],
      publishedAt: timestamps.publishedAt ?? null,
      discoveredAt: timestamps.discoveredAt ?? new Date().toISOString(),
      sourceType: 'web',
      platform: 'Web',
      authorName: null,
      authorHandle: null,
      externalId: null,
      provenanceKind: 'ai_citation',
    };
    this.items.push(item);
    return structuredClone(item);
  }

  seedDiscovery(userId: string, kind: DiscoveryKind): DiscoveryItem {
    const topic = this.seedTopic(userId, `${kind}-${randomUUID()}`);
    return this.seedItem(topic.id, kind);
  }

  async completeFakeDiscovery(
    userId: string,
    topicId: string,
    result: { expandedTerms: string[]; items: DiscoveryCandidate[] },
  ): Promise<void> {
    const topic = this.topics.find(
      (candidate) => candidate.id === topicId && candidate.userId === userId,
    );
    if (!topic) return;
    topic.expandedTerms = [...result.expandedTerms];
    topic.runStatus = 'succeeded';
    topic.lastRunAt = new Date().toISOString();
    topic.lastError = null;
    for (const candidate of result.items) {
      const primary = canonicalizeUrl(candidate.sourceUrls[0]!);
      const existing = this.items.find(
        (item) =>
          item.topicId === topicId && canonicalizeUrl(item.sourceUrls[0]!) === primary,
      );
      if (existing) {
        Object.assign(existing, candidate);
      } else {
        this.items.push({
          ...candidate,
          id: randomUUID(),
          topicId,
          discoveredAt: new Date().toISOString(),
        });
      }
    }
  }

  async close(): Promise<void> {}
}
