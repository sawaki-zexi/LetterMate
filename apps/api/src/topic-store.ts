import {
  discoveryItemSchema,
  topicFeedItemSchema,
  trendFeedItemSchema,
  trendStatusSchema,
  runSummarySchema,
  safeErrorSchema,
  topicSchema,
  type DiscoveryCandidate,
  type DiscoveryItem,
  type DiscoveryKind,
  type FeedItem,
  type FeedOrigin,
  type RunSummary,
  type RunStatus,
  type SafeError,
  type Topic,
  type TrendFeedItem,
  type TrendStatus,
} from '@lettermate/contracts';
import { canonicalizeUrl, normalizeKeyword } from '@lettermate/domain';
import {
  Prisma,
  type DiscoveryRun as PrismaDiscoveryRun,
  type DiscoveryItem as PrismaDiscoveryItem,
  type RadarItem as PrismaRadarItem,
  type Topic as PrismaTopic,
  type TrendMonitor as PrismaTrendMonitor,
  type TrendRun as PrismaTrendRun,
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
  queueRefresh(userId: string, id: string): Promise<QueueRefreshResult | null>;
  listFeed(
    userId: string,
    filter: FeedStoreFilter,
  ): Promise<FeedItem[]>;
  findItem(userId: string, id: string): Promise<FeedItem | null>;
  getTrendStatus(userId: string, intervalHours: number, now?: Date): Promise<TrendStatus>;
  queueTrendRefresh(
    userId: string,
    intervalHours: number,
    now?: Date,
  ): Promise<QueueTrendRefreshResult>;
  compensateTrendRefresh(
    userId: string,
    registration: TrendRefreshRegistration,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface FeedStoreFilter {
  topicId?: string;
  kind?: DiscoveryKind;
  since: Date | null;
  origin: FeedOrigin;
}

export interface QueueRefreshResult {
  topic: Topic;
  shouldEnqueue: boolean;
}

export interface QueueTrendRefreshResult {
  status: TrendStatus;
  shouldEnqueue: boolean;
  registration: TrendRefreshRegistration | null;
}

export interface TrendRefreshRegistration {
  monitorId: string;
  activeRunId: string | null;
  runLeaseUntil: Date | null;
  previousRunStatus: RunStatus;
  previousLastError: SafeError | null;
}

type TopicWithRuns = PrismaTopic & { runs?: PrismaDiscoveryRun[] };
type TrendMonitorWithRuns = PrismaTrendMonitor & { runs?: PrismaTrendRun[] };

const latestRunInclude = {
  runs: { orderBy: [{ startedAt: 'desc' as const }, { id: 'desc' as const }], take: 1 },
};

function mapRunSummary(run: PrismaDiscoveryRun | PrismaTrendRun | undefined): RunSummary | null {
  if (!run) return null;
  const unfinished = run.status === 'queued' || run.status === 'running';
  return runSummarySchema.parse({
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: unfinished ? null : run.finishedAt?.toISOString() ?? null,
    newItemCount: run.status === 'succeeded' ? run.newItemCount : null,
  });
}

function mapTopic(topic: TopicWithRuns): Topic {
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
    lastRun: mapRunSummary(topic.runs?.[0]),
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

function mapTopicFeedItem(item: PrismaDiscoveryItem): FeedItem {
  return topicFeedItemSchema.parse({ ...mapItem(item), origin: 'topic' });
}

function mapRadarFeedItem(item: PrismaRadarItem): FeedItem {
  return trendFeedItemSchema.parse({
    id: item.id,
    topicId: null,
    origin: 'trend',
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

function mapTrendStatus(monitor: TrendMonitorWithRuns): TrendStatus {
  const error = safeErrorSchema.safeParse(monitor.lastError);
  return trendStatusSchema.parse({
    runStatus: monitor.runStatus,
    nextRunAt: monitor.nextRunAt?.toISOString() ?? null,
    intervalHours: monitor.intervalHours,
    lastError: error.success ? error.data : null,
    lastRun: mapRunSummary(monitor.runs?.[0]),
  });
}

const effectiveTimestamp = (item: FeedItem): string => item.publishedAt ?? item.discoveredAt;

function sortFeed(items: FeedItem[]): FeedItem[] {
  return items.sort((left, right) => {
    const byTime = effectiveTimestamp(right).localeCompare(effectiveTimestamp(left));
    return byTime || right.id.localeCompare(left.id);
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
        include: latestRunInclude,
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
      include: latestRunInclude,
    });
    return topics.map(mapTopic);
  }

  async findTopic(userId: string, id: string): Promise<Topic | null> {
    const topic = await this.prisma.topic.findFirst({
      where: { id, userId },
      include: latestRunInclude,
    });
    return topic ? mapTopic(topic) : null;
  }

  async queueRefresh(userId: string, id: string): Promise<QueueRefreshResult | null> {
    return this.prisma.$transaction(async (transaction) => {
      let topic = await transaction.topic.findFirst({
        where: { id, userId }, include: latestRunInclude,
      });
      if (!topic) return null;

      if (topic.runStatus === 'running') {
        const pending = await transaction.topic.updateMany({
          where: { id, userId, runStatus: 'running', manualRefreshPending: false },
          data: { manualRefreshPending: true, lastError: Prisma.DbNull },
        });
        topic = await transaction.topic.findFirst({
          where: { id, userId }, include: latestRunInclude,
        });
        if (!topic) return null;
        if (pending.count === 1) {
          return { topic: mapTopic(topic), shouldEnqueue: true };
        }
        if (topic.runStatus === 'running' || topic.runStatus === 'queued') {
          return { topic: mapTopic(topic), shouldEnqueue: false };
        }
      }

      if (topic.runStatus === 'queued') {
        return { topic: mapTopic(topic), shouldEnqueue: false };
      }

      const queued = await transaction.topic.updateMany({
        where: { id, userId, runStatus: { in: ['succeeded', 'failed'] } },
        data: { runStatus: 'queued', lastError: Prisma.DbNull },
      });
      topic = await transaction.topic.findFirst({
        where: { id, userId }, include: latestRunInclude,
      });
      if (!topic) return null;
      return { topic: mapTopic(topic), shouldEnqueue: queued.count === 1 };
    });
  }

  async listFeed(
    userId: string,
    filter: FeedStoreFilter,
  ): Promise<FeedItem[]> {
    const timeWhere = filter.since ? {
      OR: [
        { publishedAt: { gte: filter.since } },
        { publishedAt: null, discoveredAt: { gte: filter.since } },
      ],
    } : {};
    const topicPromise = filter.origin === 'trend'
      ? Promise.resolve([] as PrismaDiscoveryItem[])
      : this.prisma.discoveryItem.findMany({
          where: {
            ...(filter.kind ? { kind: filter.kind } : {}),
            ...timeWhere,
            topic: {
              userId,
              ...(filter.topicId ? { id: filter.topicId } : {}),
            },
          },
          orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
        });
    const radarPromise = filter.origin === 'topic' || filter.topicId
      ? Promise.resolve([] as PrismaRadarItem[])
      : this.prisma.radarItem.findMany({
          where: {
            userId,
            ...(filter.kind ? { kind: filter.kind } : {}),
            ...timeWhere,
          },
          orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
        });
    const [topicItems, radarItems] = await Promise.all([topicPromise, radarPromise]);
    return sortFeed([
      ...topicItems.map(mapTopicFeedItem),
      ...radarItems.map(mapRadarFeedItem),
    ]);
  }

  async findItem(userId: string, id: string): Promise<FeedItem | null> {
    const item = await this.prisma.discoveryItem.findFirst({
      where: { id, topic: { userId } },
    });
    if (item) return mapTopicFeedItem(item);
    const radar = await this.prisma.radarItem.findFirst({ where: { id, userId } });
    return radar ? mapRadarFeedItem(radar) : null;
  }

  async getTrendStatus(userId: string, intervalHours: number, now = new Date()): Promise<TrendStatus> {
    await this.prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        email: `${userId}@example.local`,
        passwordHash: 'local-prototype-no-login-credential',
        timezone: 'Asia/Shanghai',
      },
      update: {},
    });
    const monitor = await this.prisma.trendMonitor.upsert({
      where: { userId },
      create: { userId, intervalHours, nextRunAt: now, runStatus: 'queued' },
      update: {},
      include: latestRunInclude,
    });
    return mapTrendStatus(monitor);
  }

  async queueTrendRefresh(
    userId: string,
    intervalHours: number,
    now = new Date(),
  ): Promise<QueueTrendRefreshResult> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.user.upsert({
        where: { id: userId },
        create: {
          id: userId,
          email: `${userId}@example.local`,
          passwordHash: 'local-prototype-no-login-credential',
          timezone: 'Asia/Shanghai',
        },
        update: {},
      });
      let monitor = await transaction.trendMonitor.upsert({
        where: { userId },
        create: { userId, intervalHours, nextRunAt: now, runStatus: 'queued' },
        update: {},
        include: latestRunInclude,
      });
      while (true) {
        if (monitor.manualRefreshPending) {
          return {
            status: mapTrendStatus(monitor), shouldEnqueue: false, registration: null,
          };
        }
        const active = monitor.runLeaseUntil !== null && monitor.runLeaseUntil > now &&
          (monitor.runStatus === 'queued' || monitor.runStatus === 'running');
        const previousError = safeErrorSchema.safeParse(monitor.lastError);
        const registration: TrendRefreshRegistration | null = active ? null : {
          monitorId: monitor.id,
          activeRunId: monitor.activeRunId,
          runLeaseUntil: monitor.runLeaseUntil,
          previousRunStatus: monitor.runStatus,
          previousLastError: previousError.success ? previousError.data : null,
        };
        const updated = await transaction.trendMonitor.updateMany({
          where: active
            ? {
                id: monitor.id, userId, manualRefreshPending: false,
                activeRunId: monitor.activeRunId,
                runLeaseUntil: { gt: now },
                runStatus: { in: ['queued', 'running'] },
              }
            : {
                id: monitor.id, userId, manualRefreshPending: false,
                OR: [
                  { activeRunId: null },
                  { runLeaseUntil: null },
                  { runLeaseUntil: { lte: now } },
                  { runStatus: { notIn: ['queued', 'running'] } },
                ],
              },
          data: {
            manualRefreshPending: true,
            lastError: Prisma.DbNull,
            ...(active ? {} : { runStatus: 'queued' as const }),
          },
        });
        monitor = await transaction.trendMonitor.findUniqueOrThrow({
          where: { userId }, include: latestRunInclude,
        });
        if (updated.count === 1) {
          if (active) {
            return {
              status: mapTrendStatus(monitor), shouldEnqueue: false, registration: null,
            };
          }
          return {
            status: mapTrendStatus(monitor),
            shouldEnqueue: true,
            registration,
          };
        }
      }
    });
  }

  async compensateTrendRefresh(
    userId: string,
    registration: TrendRefreshRegistration,
  ): Promise<boolean> {
    const compensated = await this.prisma.trendMonitor.updateMany({
      where: {
        id: registration.monitorId,
        userId,
        manualRefreshPending: true,
        runStatus: 'queued',
        activeRunId: registration.activeRunId,
        runLeaseUntil: registration.runLeaseUntil,
      },
      data: {
        manualRefreshPending: false,
        runStatus: registration.previousRunStatus,
        lastError: registration.previousLastError ?? Prisma.DbNull,
      },
    });
    return compensated.count === 1;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

export class MemoryTopicStore implements TopicStore {
  private readonly topics: Topic[] = [];
  private readonly items: DiscoveryItem[] = [];
  private readonly radarItems: Array<TrendFeedItem & { userId: string }> = [];
  private readonly pendingManualRefreshes = new Set<string>();
  private readonly trendMonitors = new Map<string, TrendStatus & { manualRefreshPending: boolean }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

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
    const startedAt = this.now().toISOString();
    const topic: Topic = {
      id: randomUUID(),
      userId,
      keyword,
      expandedTerms: [],
      createdAt: startedAt,
      lastRunAt: null,
      nextRunAt: null,
      scheduleIntervalHours: 12,
      runStatus: 'queued',
      lastError: null,
      lastRun: {
        id: randomUUID(), trigger: 'initial', status: 'queued', startedAt,
        finishedAt: null, newItemCount: null,
      },
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

  async queueRefresh(userId: string, id: string): Promise<QueueRefreshResult | null> {
    const topic = this.topics.find((candidate) => candidate.userId === userId && candidate.id === id);
    if (!topic) return null;
    if (topic.runStatus === 'running') {
      const shouldEnqueue = !this.pendingManualRefreshes.has(id);
      this.pendingManualRefreshes.add(id);
      topic.lastError = null;
      return { topic: structuredClone(topic), shouldEnqueue };
    }
    if (topic.runStatus === 'queued') {
      return { topic: structuredClone(topic), shouldEnqueue: false };
    }
    topic.runStatus = 'queued';
    topic.lastError = null;
    return { topic: structuredClone(topic), shouldEnqueue: true };
  }

  async listFeed(
    userId: string,
    filter: FeedStoreFilter,
  ): Promise<FeedItem[]> {
    const topicIds = new Set(
      this.topics.filter((topic) => topic.userId === userId).map((topic) => topic.id),
    );
    const topicItems = filter.origin === 'trend' ? [] : this.items
      .filter(
        (item) =>
          topicIds.has(item.topicId) &&
          (!filter.topicId || item.topicId === filter.topicId) &&
          (!filter.kind || item.kind === filter.kind) &&
          (!filter.since || (item.publishedAt ?? item.discoveredAt) >= filter.since.toISOString()),
      )
      .map((item) => topicFeedItemSchema.parse({ ...item, origin: 'topic' }));
    const radarItems = filter.origin === 'topic' || filter.topicId ? [] : this.radarItems
      .filter((item) =>
        item.userId === userId &&
        (!filter.kind || item.kind === filter.kind) &&
        (!filter.since || (item.publishedAt ?? item.discoveredAt) >= filter.since.toISOString()))
      .map(({ userId: _userId, ...item }) => trendFeedItemSchema.parse(item));
    return sortFeed([...topicItems, ...radarItems]).map((item) => structuredClone(item));
  }

  async findItem(userId: string, id: string): Promise<FeedItem | null> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item) {
      const ownsTopic = this.topics.some(
        (topic) => topic.id === item.topicId && topic.userId === userId,
      );
      return ownsTopic
        ? structuredClone(topicFeedItemSchema.parse({ ...item, origin: 'topic' }))
        : null;
    }
    const radar = this.radarItems.find(
      (candidate) => candidate.id === id && candidate.userId === userId,
    );
    if (!radar) return null;
    const { userId: _userId, ...feedItem } = radar;
    return structuredClone(trendFeedItemSchema.parse(feedItem));
  }

  async getTrendStatus(
    userId: string,
    intervalHours: number,
    now = this.now(),
  ): Promise<TrendStatus> {
    const existing = this.trendMonitors.get(userId);
    if (existing) {
      const { manualRefreshPending: _pending, ...status } = existing;
      return structuredClone(trendStatusSchema.parse(status));
    }
    const monitor: TrendStatus & { manualRefreshPending: boolean } = {
      runStatus: 'queued',
      nextRunAt: now.toISOString(),
      intervalHours,
      lastError: null,
      lastRun: null,
      manualRefreshPending: false,
    };
    this.trendMonitors.set(userId, monitor);
    const { manualRefreshPending: _pending, ...status } = monitor;
    return structuredClone(trendStatusSchema.parse(status));
  }

  async queueTrendRefresh(
    userId: string,
    intervalHours: number,
    now = this.now(),
  ): Promise<QueueTrendRefreshResult> {
    await this.getTrendStatus(userId, intervalHours, now);
    const monitor = this.trendMonitors.get(userId)!;
    if (monitor.manualRefreshPending) {
      const { manualRefreshPending: _pending, ...status } = monitor;
      return {
        status: structuredClone(trendStatusSchema.parse(status)),
        shouldEnqueue: false,
        registration: null,
      };
    }
    const registration: TrendRefreshRegistration = {
      monitorId: userId,
      activeRunId: null,
      runLeaseUntil: null,
      previousRunStatus: monitor.runStatus,
      previousLastError: monitor.lastError,
    };
    monitor.manualRefreshPending = true;
    if (monitor.runStatus === 'running') {
      monitor.lastError = null;
      const { manualRefreshPending: _pending, ...status } = monitor;
      return {
        status: structuredClone(trendStatusSchema.parse(status)),
        shouldEnqueue: false,
        registration: null,
      };
    }
    monitor.runStatus = 'queued';
    monitor.lastError = null;
    const { manualRefreshPending: _pending, ...status } = monitor;
    return {
      status: structuredClone(trendStatusSchema.parse(status)),
      shouldEnqueue: true,
      registration,
    };
  }

  async compensateTrendRefresh(
    userId: string,
    registration: TrendRefreshRegistration,
  ): Promise<boolean> {
    const monitor = this.trendMonitors.get(userId);
    if (
      !monitor || registration.monitorId !== userId ||
      !monitor.manualRefreshPending || monitor.runStatus !== 'queued'
    ) {
      return false;
    }
    monitor.manualRefreshPending = false;
    monitor.runStatus = registration.previousRunStatus;
    monitor.lastError = registration.previousLastError;
    return true;
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
      lastRun: null,
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

  seedRadarItem(
    userId: string,
    kind: DiscoveryKind,
    timestamps: { publishedAt?: string | null; discoveredAt?: string } = {},
  ): TrendFeedItem {
    const id = randomUUID();
    const item = trendFeedItemSchema.parse({
      id,
      topicId: null,
      origin: 'trend',
      kind,
      title: kind === 'hot' ? 'Trend hot content' : 'Trend quality content',
      summary: 'Chinese summary',
      reason: 'Supported by substantive source material',
      sourceUrls: [`https://example.com/radar/${id}`],
      publishedAt: timestamps.publishedAt ?? null,
      discoveredAt: timestamps.discoveredAt ?? this.now().toISOString(),
      sourceType: 'web',
      platform: 'Web',
      authorName: null,
      authorHandle: null,
      externalId: null,
      provenanceKind: 'ai_citation',
    });
    this.radarItems.push({ ...item, userId });
    return structuredClone(item);
  }

  async startFakeDiscovery(userId: string, topicId: string): Promise<void> {
    const topic = this.topics.find(
      (candidate) => candidate.id === topicId && candidate.userId === userId,
    );
    if (!topic) return;
    const run = topic.lastRun?.status === 'queued' || topic.lastRun?.status === 'running'
      ? topic.lastRun
      : {
          id: randomUUID(), trigger: 'manual' as const, status: 'queued' as const,
          startedAt: this.now().toISOString(), finishedAt: null, newItemCount: null,
        };
    topic.runStatus = 'running';
    topic.lastRun = {
      id: run.id, trigger: run.trigger, status: 'running', startedAt: run.startedAt,
      finishedAt: null, newItemCount: null,
    };
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
    if (!topic.lastRun) await this.startFakeDiscovery(userId, topicId);
    const run = topic.lastRun!;
    topic.expandedTerms = [...result.expandedTerms];
    topic.runStatus = 'succeeded';
    topic.lastRunAt = this.now().toISOString();
    topic.lastError = null;
    this.pendingManualRefreshes.delete(topicId);
    let newItemCount = 0;
    for (const candidate of result.items) {
      const primary = canonicalizeUrl(candidate.sourceUrls[0]!);
      const existing = this.items.find(
        (item) =>
          item.topicId === topicId && canonicalizeUrl(item.sourceUrls[0]!) === primary,
      );
      if (existing) {
        Object.assign(existing, candidate);
      } else {
        newItemCount += 1;
        this.items.push({
          ...candidate,
          id: randomUUID(),
          topicId,
          discoveredAt: this.now().toISOString(),
        });
      }
    }
    topic.lastRun = {
      id: run.id, trigger: run.trigger, status: 'succeeded', startedAt: run.startedAt,
      finishedAt: this.now().toISOString(), newItemCount,
    };
  }

  async failFakeDiscovery(userId: string, topicId: string, error: SafeError): Promise<void> {
    const topic = this.topics.find(
      (candidate) => candidate.id === topicId && candidate.userId === userId,
    );
    if (!topic) return;
    if (!topic.lastRun) await this.startFakeDiscovery(userId, topicId);
    const run = topic.lastRun!;
    topic.runStatus = 'failed';
    topic.lastError = safeErrorSchema.parse(error);
    topic.lastRunAt = this.now().toISOString();
    topic.lastRun = {
      id: run.id, trigger: run.trigger, status: 'failed', startedAt: run.startedAt,
      finishedAt: this.now().toISOString(), newItemCount: null,
    };
    this.pendingManualRefreshes.delete(topicId);
  }

  async startFakeTrendDiscovery(userId: string, intervalHours: number): Promise<void> {
    await this.getTrendStatus(userId, intervalHours);
    const monitor = this.trendMonitors.get(userId)!;
    const run = monitor.manualRefreshPending || !monitor.lastRun ||
      monitor.lastRun.status === 'succeeded' || monitor.lastRun.status === 'failed'
      ? {
      id: randomUUID(), trigger: 'manual' as const, status: 'queued' as const,
      startedAt: this.now().toISOString(), finishedAt: null, newItemCount: null,
        }
      : monitor.lastRun;
    monitor.runStatus = 'running';
    monitor.lastRun = {
      id: run.id, trigger: run.trigger, status: 'running', startedAt: run.startedAt,
      finishedAt: null, newItemCount: null,
    };
    monitor.manualRefreshPending = false;
  }

  async completeFakeTrendDiscovery(
    userId: string,
    intervalHours: number,
    candidates: DiscoveryCandidate[],
  ): Promise<void> {
    await this.startFakeTrendDiscovery(userId, intervalHours);
    const monitor = this.trendMonitors.get(userId)!;
    const run = monitor.lastRun!;
    let newItemCount = 0;
    for (const candidate of candidates) {
      const primary = canonicalizeUrl(candidate.sourceUrls[0]!);
      const existing = this.radarItems.find(
        (item) => item.userId === userId && canonicalizeUrl(item.sourceUrls[0]!) === primary,
      );
      if (existing) {
        Object.assign(existing, candidate);
      } else {
        const id = randomUUID();
        this.radarItems.push({
          ...candidate, id, userId, topicId: null, origin: 'trend',
          discoveredAt: this.now().toISOString(),
        });
        newItemCount += 1;
      }
    }
    monitor.runStatus = 'succeeded';
    monitor.lastError = null;
    monitor.lastRun = {
      id: run.id, trigger: run.trigger, status: 'succeeded', startedAt: run.startedAt,
      finishedAt: this.now().toISOString(), newItemCount,
    };
  }

  async failFakeTrendDiscovery(
    userId: string,
    intervalHours: number,
    error: SafeError,
  ): Promise<void> {
    await this.startFakeTrendDiscovery(userId, intervalHours);
    const monitor = this.trendMonitors.get(userId)!;
    const run = monitor.lastRun!;
    monitor.runStatus = 'failed';
    monitor.lastError = safeErrorSchema.parse(error);
    monitor.lastRun = {
      id: run.id, trigger: run.trigger, status: 'failed', startedAt: run.startedAt,
      finishedAt: this.now().toISOString(), newItemCount: null,
    };
  }

  async close(): Promise<void> {}
}
