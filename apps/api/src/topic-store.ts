import {
  creatorFeedItemSchema,
  creatorDegradedSourceSchema,
  contentFeedbackSchema,
  savedContentSchema,
  creatorItemSchema,
  creatorSchema,
  discoveryItemSchema,
  defaultFeedPageLimit,
  topicFeedItemSchema,
  trendFeedItemSchema,
  trendStatusSchema,
  runSummarySchema,
  safeErrorSchema,
  topicSchema,
  type Creator,
  type CreatorFeedItem,
  type CreatorItem,
  type ContentFeedback,
  type SavedContent,
  type DiscoveryCandidate,
  type DiscoveryItem,
  type DiscoveryKind,
  type FeedPage,
  type FeedItem,
  type FeedImpressionInput,
  type FeedImpressionReceipt,
  type FeedRecommendation,
  type FeedbackValue,
  type FeedOrigin,
  type ReadingState,
  type InterestEvent,
  type RunSummary,
  type RunStatus,
  type SafeError,
  type Topic,
  type TrendFeedItem,
  type TrendStatus,
} from '@lettermate/contracts';
import { canonicalizeUrl, mergeFeedItems, normalizeKeyword } from '@lettermate/domain';
import {
  Prisma,
  type DiscoveryRun as PrismaDiscoveryRun,
  type DiscoveryItem as PrismaDiscoveryItem,
  type RadarItem as PrismaRadarItem,
  type Topic as PrismaTopic,
  type TrendMonitor as PrismaTrendMonitor,
  type TrendRun as PrismaTrendRun,
  type CreatorSubscription as PrismaCreatorSubscription,
  type CreatorRun as PrismaCreatorRun,
  type CreatorItem as PrismaCreatorItem,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  buildTopicRankQuery,
  buildTrendRankQuery,
  memorySearchRelevance,
  sortRankedFeed,
  type RankedId,
} from './feed-search.js';
import {
  appendInterestEvent,
  appendMemoryInterestEvent,
  mapInterestEvent,
} from './interest-events.js';
import type { PersonalizationMemory, PersonalizedSlate } from './personalization-memory.js';
import {
  createFeedCursor,
  resolveFeedPagination,
  type FeedPaginationContext,
} from './feed-pagination.js';
import {
  MemoryTopicDispatchOutbox,
  NoopTopicDispatchOutbox,
  PrismaTopicDispatchOutbox,
  type TopicDispatchOutbox,
} from './topic-dispatch-outbox.js';

export class TopicAlreadyExistsError extends Error {
  constructor() {
    super('Topic already exists');
    this.name = 'TopicAlreadyExistsError';
  }
}

export class CreatorAlreadyExistsError extends Error {
  constructor() {
    super('Creator already exists');
    this.name = 'CreatorAlreadyExistsError';
  }
}

class SavedContentBatchTargetNotFoundError extends Error {
  constructor() {
    super('Saved content batch target not found');
    this.name = 'SavedContentBatchTargetNotFoundError';
  }
}

export interface TopicStore {
  readonly topicDispatchOutbox: TopicDispatchOutbox;
  createCreator(userId: string, input: CreatorCreateInput): Promise<Creator>;
  createCreators(userId: string, inputs: CreatorCreateInput[]): Promise<Creator[]>;
  listCreators(userId: string): Promise<Creator[]>;
  findCreator(userId: string, id: string): Promise<Creator | null>;
  updateCreator(userId: string, id: string, input: CreatorUpdate): Promise<Creator | null>;
  deleteCreator(userId: string, id: string): Promise<boolean>;
  queueCreatorRefresh(userId: string, id: string): Promise<CreatorQueueResult | null>;
  compensateCreatorRefresh(userId: string, id: string): Promise<boolean>;
  listCreatorItems(userId: string, id: string): Promise<CreatorItem[] | null>;
  createTopic(userId: string, keyword: string, normalizedKeyword: string): Promise<Topic>;
  updateTopic(userId: string, id: string, input: TopicUpdate): Promise<QueueRefreshResult | null>;
  pauseTopic(userId: string, id: string): Promise<Topic | null>;
  resumeTopic(userId: string, id: string): Promise<QueueRefreshResult | null>;
  deleteTopic(userId: string, id: string): Promise<boolean>;
  compensateTopicRefresh(userId: string, id: string): Promise<boolean>;
  listTopics(userId: string): Promise<Topic[]>;
  findTopic(userId: string, id: string): Promise<Topic | null>;
  queueRefresh(userId: string, id: string): Promise<QueueRefreshResult | null>;
  listFeed(
    userId: string,
    filter: FeedStoreFilter,
  ): Promise<FeedPage>;
  recordFeedImpressions(
    userId: string,
    input: FeedImpressionInput,
  ): Promise<FeedImpressionReceipt | null>;
  setFeedback(
    userId: string,
    contentKey: string,
    value: FeedbackValue | null,
  ): Promise<ContentFeedback | null>;
  setSavedContent(
    userId: string,
    contentKey: string,
    state: ReadingState | null,
  ): Promise<SavedContent | null>;
  setSavedContentBatch(
    userId: string,
    contentKeys: string[],
    state: 'archived',
  ): Promise<SavedContent[] | null>;
  listInterestEvents(userId: string): Promise<InterestEvent[]>;
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
  healthCheck?(): Promise<void>;
}

export interface TopicUpdate {
  keyword: string;
  normalizedKeyword: string;
  /** @deprecated Query variants are regenerated after a keyword change. */
  expandedTerms?: string[] | undefined;
}

export interface CreatorCreateInput {
  platform: 'rss' | 'x' | 'bilibili' | 'youtube' | 'bluesky';
  accountKey: string;
  displayName: string;
  profileUrl: string;
  feedUrl: string | null;
}

export interface CreatorUpdate {
  paused: boolean;
}

export interface CreatorQueueResult {
  creator: Creator;
  shouldEnqueue: boolean;
}

export interface FeedStoreFilter {
  topicId?: string;
  kind?: DiscoveryKind;
  since: Date | null;
  origin: FeedOrigin;
  query?: string;
  reading?: ReadingState;
  limit?: number;
  cursor?: string;
  windowKey?: string;
  snapshotAt?: Date;
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
  runId: string;
  registrationUntil: Date;
  previousActiveRunId: string | null;
  previousRunLeaseUntil: Date | null;
  previousRunStatus: RunStatus;
  previousLastError: SafeError | null;
  previousLastRun: RunSummary | null;
}

const TREND_QUEUE_REGISTRATION_MS = 20 * 60_000;
const TOPIC_QUEUE_ERROR: SafeError = {
  code: 'TOPIC_QUEUE_UNAVAILABLE',
  message: '发现任务暂时无法入队，请稍后重试',
};

type TopicWithRuns = PrismaTopic & { runs?: PrismaDiscoveryRun[] };
type TrendMonitorWithRuns = PrismaTrendMonitor & { runs?: PrismaTrendRun[] };

const latestRunInclude = {
  runs: { orderBy: [{ startedAt: 'desc' as const }, { id: 'desc' as const }], take: 1 },
};

function mapRunSummary(
  run: PrismaDiscoveryRun | PrismaTrendRun | PrismaCreatorRun | undefined,
): RunSummary | null {
  if (!run) return null;
  const unfinished = run.status === 'queued' || run.status === 'running';
  return runSummarySchema.parse({
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: unfinished ? null : run.finishedAt?.toISOString() ?? null,
    newItemCount: run.status === 'succeeded' || run.status === 'degraded' ? run.newItemCount : null,
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
    pausedAt: topic.pausedAt?.toISOString() ?? null,
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

function mapTopicFeedItem(item: PrismaDiscoveryItem & { topic?: { deletedAt: Date | null; keyword: string } }): FeedItem {
  const topicKeywordActive = item.topic?.deletedAt === null && item.topic.keyword === item.topicKeyword;
  return topicFeedItemSchema.parse({
    ...mapItem(item),
    origin: 'topic',
    topicKeyword: item.topicKeyword,
    topicKeywordActive,
    contentKey: item.canonicalPrimaryUrl,
    feedback: null,
    origins: [{
      origin: 'topic',
      topicId: item.topicId,
      topicKeyword: item.topicKeyword,
      topicKeywordActive,
    }],
  });
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
    contentKey: item.canonicalPrimaryUrl,
    feedback: null,
    origins: [{ origin: 'trend' }],
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

const FEED_SOURCE_CANDIDATE_LIMIT = 300;
const LOCAL_FEED_CURSOR_SECRET = 'lettermate-local-feed-cursor-secret-v1';

function sortFeed(items: FeedItem[]): FeedItem[] {
  return items.sort((left, right) => {
    const byTime = effectiveTimestamp(right).localeCompare(effectiveTimestamp(left));
    return byTime || right.id.localeCompare(left.id);
  });
}

function paginationContext(
  userId: string,
  filter: FeedStoreFilter,
  now: Date,
  cursorSecret: string,
): FeedPaginationContext {
  const limit = filter.limit ?? defaultFeedPageLimit;
  return resolveFeedPagination({
    userId,
    filter: {
      origin: filter.origin,
      topicId: filter.topicId ?? null,
      kind: filter.kind ?? null,
      query: filter.query ?? null,
      reading: filter.reading ?? null,
      windowKey: filter.windowKey ?? filter.since?.toISOString() ?? 'all',
      limit,
    },
    since: filter.since,
    now,
    secret: cursorSecret,
    ...(filter.cursor ? { cursor: filter.cursor } : {}),
  });
}

function feedPage(
  items: FeedItem[],
  pagination: FeedPaginationContext,
  truncated: boolean,
  cursorSecret: string,
): FeedPage {
  const end = pagination.offset + pagination.limit;
  return {
    items: items.slice(pagination.offset, end),
    nextCursor: end < items.length ? createFeedCursor(pagination, end, cursorSecret) : null,
    truncated,
  };
}

export class PrismaTopicStore implements TopicStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personalization?: PersonalizationMemory,
    private readonly cursorSecret = LOCAL_FEED_CURSOR_SECRET,
    public readonly topicDispatchOutbox: TopicDispatchOutbox = 'topicDispatchOutbox' in prisma
      ? new PrismaTopicDispatchOutbox(prisma)
      : new NoopTopicDispatchOutbox(),
  ) {}

  private async personalizeFeed(
    userId: string,
    items: FeedItem[],
    asOf: Date,
  ): Promise<FeedItem[]> {
    if (!this.personalization || items.length === 0) return items;
    try {
      const selection = await this.personalization.select({
        userId,
        surface: 'feed',
        candidates: items,
        asOf,
      });
      if (!selection.personalizationEnabled) return items;
      const itemByKey = new Map(items.map((item) => [item.contentKey, item]));
      const personalized = selection.ranked.flatMap((ranked) => {
        const item = itemByKey.get(ranked.contentKey);
        if (!item) return [];
        itemByKey.delete(ranked.contentKey);
        return [{ ...item, recommendation: publicRecommendation(ranked, selection.decisionId) }];
      });
      return [...personalized, ...itemByKey.values()];
    } catch {
      return items;
    }
  }

  private async attachFeedback(userId: string, items: FeedItem[]): Promise<FeedItem[]> {
    if (items.length === 0) return items;
    const contentKeys = [...new Set(items.map((item) => canonicalizeUrl(item.contentKey)))];
    const [feedbackRows, savedRows] = await Promise.all([
      this.prisma.contentFeedback.findMany({
        where: { userId, contentKey: { in: contentKeys } },
        select: { contentKey: true, value: true },
      }),
      this.prisma.savedContent.findMany({
        where: { userId, contentKey: { in: contentKeys }, removedAt: null },
        select: { contentKey: true, state: true },
      }),
    ]);
    const feedbackByKey = new Map(feedbackRows.map((row) => [row.contentKey, row.value]));
    const readingStateByKey = new Map(savedRows.map((row) => [row.contentKey, row.state]));
    return items.map((item) => ({
      ...item,
      feedback: feedbackByKey.get(canonicalizeUrl(item.contentKey)) ?? null,
      readingState: readingStateByKey.get(canonicalizeUrl(item.contentKey)) ?? null,
    }));
  }

  private async savedContentKeys(userId: string, state: ReadingState, snapshotAt: Date): Promise<{
    keys: string[];
    truncated: boolean;
  }> {
    const rows = await this.prisma.savedContent.findMany({
      where: {
        userId,
        state,
        savedAt: { lte: snapshotAt },
        OR: [{ removedAt: null }, { removedAt: { gt: snapshotAt } }],
      },
      select: { contentKey: true },
      orderBy: [{ savedAt: 'desc' }, { contentKey: 'desc' }],
      take: FEED_SOURCE_CANDIDATE_LIMIT + 1,
    });
    return {
      keys: rows.slice(0, FEED_SOURCE_CANDIDATE_LIMIT).map((row) => row.contentKey),
      truncated: rows.length > FEED_SOURCE_CANDIDATE_LIMIT,
    };
  }

  async createTopic(
    userId: string,
    keyword: string,
    normalizedKeyword: string,
  ): Promise<Topic> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const topic = await transaction.topic.create({
          data: {
            keyword,
            normalizedKeyword,
            queuedTrigger: 'initial',
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
        await this.topicDispatchOutbox.register({
          topicId: topic.id,
          userId,
          trigger: 'initial',
        }, transaction);
        await appendInterestEvent(transaction, {
          userId,
          eventType: 'topic_state',
          sourceRef: topic.id,
          payload: {
            schemaVersion: 1,
            state: 'active',
            topicId: topic.id,
            keyword: topic.keyword,
            normalizedKeyword: topic.normalizedKeyword,
          },
          occurredAt: topic.createdAt,
        });
        return mapTopic(topic);
      });
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
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: latestRunInclude,
    });
    return topics.map(mapTopic);
  }

  async createCreator(userId: string, input: CreatorCreateInput): Promise<Creator> {
    return (await this.createCreators(userId, [input]))[0]!;
  }

  async createCreators(userId: string, inputs: CreatorCreateInput[]): Promise<Creator[]> {
    if (inputs.length === 0) return [];
    const inputKeys = new Set(inputs.map((input) => `${input.platform}:${input.accountKey}`));
    if (inputKeys.size !== inputs.length) throw new CreatorAlreadyExistsError();
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.user.upsert({
          where: { id: userId },
          update: {},
          create: {
            id: userId,
            email: `${userId}@example.local`,
            passwordHash: 'local-prototype-no-login-credential',
            timezone: 'Asia/Shanghai',
          },
        });
        const creators: Creator[] = [];
        for (const input of inputs) {
          const existing = await transaction.creatorSubscription.findUnique({
            where: {
              userId_platform_accountKey: {
                userId, platform: input.platform, accountKey: input.accountKey,
              },
            },
            include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
          });
          if (existing && !existing.cancelledAt) throw new CreatorAlreadyExistsError();
          const creator = existing
            ? await transaction.creatorSubscription.update({
              where: { id: existing.id },
              data: {
                displayName: input.displayName,
                profileUrl: input.profileUrl,
                feedUrl: input.feedUrl,
                cancelledAt: null,
                pausedAt: null,
                nextRunAt: null,
                runStatus: 'queued',
                lastError: Prisma.DbNull,
                degradedSources: Prisma.DbNull,
              },
              include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
            })
            : await transaction.creatorSubscription.create({
              data: {
                userId,
                platform: input.platform,
                accountKey: input.accountKey,
                displayName: input.displayName,
                profileUrl: input.profileUrl,
                feedUrl: input.feedUrl,
                nextRunAt: null,
              },
              include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
            });
          await appendInterestEvent(transaction, {
            userId,
            eventType: 'creator_state',
            sourceRef: creator.id,
            payload: {
              schemaVersion: 1,
              state: 'active',
              creatorId: creator.id,
              platform: creator.platform,
              accountKey: creator.accountKey,
              displayName: creator.displayName,
            },
            occurredAt: new Date(),
          });
          creators.push(mapCreator(creator));
        }
        return creators;
      });
    } catch (error) {
      if (error instanceof CreatorAlreadyExistsError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new CreatorAlreadyExistsError();
      }
      throw error;
    }
  }

  async listCreators(userId: string): Promise<Creator[]> {
    const creators = await this.prisma.creatorSubscription.findMany({
      where: { userId, cancelledAt: null },
      orderBy: { createdAt: 'desc' },
      include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
    });
    return creators.map(mapCreator);
  }

  async findCreator(userId: string, id: string): Promise<Creator | null> {
    const creator = await this.prisma.creatorSubscription.findFirst({
      where: { id, userId, cancelledAt: null },
      include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
    });
    return creator ? mapCreator(creator) : null;
  }

  async updateCreator(userId: string, id: string, input: CreatorUpdate): Promise<Creator | null> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.creatorSubscription.findFirst({
        where: { id, userId, cancelledAt: null },
        include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
      });
      if (!current) return null;
      const alreadyInState = input.paused ? current.pausedAt !== null : current.pausedAt === null;
      if (alreadyInState) return mapCreator(current);
      const occurredAt = new Date();
      const updated = await transaction.creatorSubscription.update({
        where: { id },
        data: input.paused
          ? { pausedAt: occurredAt, nextRunAt: null }
          : {
            pausedAt: null,
            nextRunAt: null,
            runStatus: 'succeeded',
            lastError: Prisma.DbNull,
            degradedSources: Prisma.DbNull,
          },
        include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
      });
      await appendInterestEvent(transaction, {
        userId,
        eventType: 'creator_state',
        sourceRef: updated.id,
        payload: {
          schemaVersion: 1,
          state: input.paused ? 'paused' : 'active',
          creatorId: updated.id,
          platform: updated.platform,
          accountKey: updated.accountKey,
          displayName: updated.displayName,
        },
        occurredAt,
      });
      return mapCreator(updated);
    });
  }

  async deleteCreator(userId: string, id: string): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.creatorSubscription.findFirst({
        where: { id, userId, cancelledAt: null },
      });
      if (!current) return false;
      const occurredAt = new Date();
      await transaction.creatorSubscription.update({
        where: { id },
        data: { cancelledAt: occurredAt, pausedAt: occurredAt, nextRunAt: null },
      });
      await appendInterestEvent(transaction, {
        userId,
        eventType: 'creator_state',
        sourceRef: current.id,
        payload: {
          schemaVersion: 1,
          state: 'cancelled',
          creatorId: current.id,
          platform: current.platform,
          accountKey: current.accountKey,
          displayName: current.displayName,
        },
        occurredAt,
      });
      return true;
    });
  }

  async queueCreatorRefresh(userId: string, id: string): Promise<CreatorQueueResult | null> {
    return this.prisma.$transaction(async (transaction) => {
      let creator = await transaction.creatorSubscription.findFirst({
        where: { id, userId, cancelledAt: null },
        include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
      });
      if (!creator) return null;
      if (creator.pausedAt) return { creator: mapCreator(creator), shouldEnqueue: false };
      if (creator.runStatus === 'running' || creator.runStatus === 'queued') {
        return { creator: mapCreator(creator), shouldEnqueue: false };
      }
      const updated = await transaction.creatorSubscription.updateMany({
        where: { id, userId, cancelledAt: null, runStatus: { in: ['succeeded', 'degraded', 'failed'] } },
        data: { runStatus: 'queued', lastError: Prisma.DbNull, degradedSources: Prisma.DbNull },
      });
      creator = await transaction.creatorSubscription.findFirstOrThrow({
        where: { id, userId, cancelledAt: null },
        include: { runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 1 } },
      });
      return { creator: mapCreator(creator), shouldEnqueue: updated.count === 1 };
    });
  }

  async compensateCreatorRefresh(userId: string, id: string): Promise<boolean> {
    const result = await this.prisma.creatorSubscription.updateMany({
      where: { id, userId, cancelledAt: null, runStatus: 'queued' },
      data: { runStatus: 'failed', lastError: { code: 'CREATOR_QUEUE_UNAVAILABLE', message: '博主任务暂时无法入队，请稍后重试' } },
    });
    return result.count === 1;
  }

  async listCreatorItems(userId: string, id: string): Promise<CreatorItem[] | null> {
    const creator = await this.prisma.creatorSubscription.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!creator) return null;
    const items = await this.prisma.creatorItem.findMany({
      where: { userId, creatorId: id },
      orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
    });
    return items.map(mapCreatorItem);
  }

  async findTopic(userId: string, id: string): Promise<Topic | null> {
    const topic = await this.prisma.topic.findFirst({
      where: { id, userId, deletedAt: null },
      include: latestRunInclude,
    });
    return topic ? mapTopic(topic) : null;
  }

  private async queueRefreshInTransaction(
    transaction: Prisma.TransactionClient,
    userId: string,
    id: string,
  ): Promise<QueueRefreshResult | null> {
    let topic = await transaction.topic.findFirst({
      where: { id, userId, deletedAt: null }, include: latestRunInclude,
    });
    if (!topic) return null;
    if (topic.pausedAt) return { topic: mapTopic(topic), shouldEnqueue: false };

    if (topic.runStatus === 'running') {
      const pending = await transaction.topic.updateMany({
        where: { id, userId, deletedAt: null, runStatus: 'running', manualRefreshPending: false },
        data: { manualRefreshPending: true, lastError: Prisma.DbNull },
      });
      topic = await transaction.topic.findFirst({
        where: { id, userId, deletedAt: null }, include: latestRunInclude,
      });
      if (!topic) return null;
      if (pending.count === 1 || topic.runStatus === 'running' || topic.runStatus === 'queued') {
        return { topic: mapTopic(topic), shouldEnqueue: false };
      }
    }

    if (topic.runStatus === 'queued') {
      if (topic.queuedTrigger === 'initial' || topic.queuedTrigger === 'scheduled') {
        await transaction.topic.updateMany({
          where: { id, userId, deletedAt: null, runStatus: 'queued', manualRefreshPending: false },
          data: { manualRefreshPending: true, lastError: Prisma.DbNull },
        });
        topic = await transaction.topic.findFirst({
          where: { id, userId, deletedAt: null }, include: latestRunInclude,
        });
        if (!topic) return null;
      }
      return { topic: mapTopic(topic), shouldEnqueue: false };
    }

    const queued = await transaction.topic.updateMany({
      where: { id, userId, deletedAt: null, runStatus: { in: ['succeeded', 'failed'] } },
      data: { runStatus: 'queued', queuedTrigger: 'manual', lastError: Prisma.DbNull },
    });
    topic = await transaction.topic.findFirst({
      where: { id, userId, deletedAt: null }, include: latestRunInclude,
    });
    if (!topic) return null;
    if (queued.count === 1) {
      await this.topicDispatchOutbox.register({ topicId: id, userId, trigger: 'manual' }, transaction);
    }
    return { topic: mapTopic(topic), shouldEnqueue: queued.count === 1 };
  }

  async updateTopic(userId: string, id: string, input: TopicUpdate): Promise<QueueRefreshResult | null> {
    try {
      const topicModel = this.prisma.topic as unknown as { findFirst?: unknown };
      if (typeof topicModel.findFirst !== 'function') {
        const updated = await this.prisma.$transaction(async (transaction) => {
          const result = await transaction.topic.updateMany({
            where: { id, userId, deletedAt: null },
            data: {
              keyword: input.keyword,
              normalizedKeyword: input.normalizedKeyword,
              expandedTerms: [],
              keywordProfile: 'unknown',
              variantsInitialized: false,
              nextRunAt: null,
              productiveRunStreak: 0,
              emptyRunStreak: 0,
            },
          });
          if (result.count !== 1) return false;
          await appendInterestEvent(transaction, {
            userId,
            eventType: 'topic_state',
            sourceRef: id,
            payload: {
              schemaVersion: 1,
              state: 'active',
              topicId: id,
              keyword: input.keyword,
              normalizedKeyword: input.normalizedKeyword,
            },
            occurredAt: new Date(),
          });
          return true;
        });
        return updated ? this.queueRefresh(userId, id) : null;
      }
      return await this.prisma.$transaction(async (transaction) => {
        const result = await transaction.topic.updateMany({
          where: { id, userId, deletedAt: null },
          data: {
            keyword: input.keyword,
            normalizedKeyword: input.normalizedKeyword,
            expandedTerms: [],
            keywordProfile: 'unknown',
            variantsInitialized: false,
            nextRunAt: null,
            productiveRunStreak: 0,
            emptyRunStreak: 0,
          },
        });
        if (result.count !== 1) return null;
        await appendInterestEvent(transaction, {
          userId,
          eventType: 'topic_state',
          sourceRef: id,
          payload: {
            schemaVersion: 1,
            state: 'active',
            topicId: id,
            keyword: input.keyword,
            normalizedKeyword: input.normalizedKeyword,
          },
          occurredAt: new Date(),
        });
        return this.queueRefreshInTransaction(transaction, userId, id);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new TopicAlreadyExistsError();
      }
      throw error;
    }
  }

  async pauseTopic(userId: string, id: string): Promise<Topic | null> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.topic.findFirst({
        where: { id, userId, deletedAt: null }, include: latestRunInclude,
      });
      if (!current) return null;
      if (current.pausedAt) return mapTopic(current);
      const occurredAt = new Date();
      const paused = await transaction.topic.update({
        where: { id },
        data: {
          pausedAt: occurredAt,
          nextRunAt: null,
          queuedTrigger: null,
          manualRefreshPending: false,
        },
        include: latestRunInclude,
      });
      await appendInterestEvent(transaction, {
        userId,
        eventType: 'topic_state',
        sourceRef: id,
        payload: {
          schemaVersion: 1,
          state: 'paused',
          topicId: id,
          keyword: paused.keyword,
          normalizedKeyword: paused.normalizedKeyword,
        },
        occurredAt,
      });
      return mapTopic(paused);
    });
  }

  async resumeTopic(userId: string, id: string): Promise<QueueRefreshResult | null> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.topic.findFirst({
        where: { id, userId, deletedAt: null },
      });
      if (!current) return null;
      if (current.pausedAt) {
        await transaction.topic.update({ where: { id }, data: { pausedAt: null } });
      }
      await appendInterestEvent(transaction, {
        userId,
        eventType: 'topic_state',
        sourceRef: id,
        payload: {
          schemaVersion: 1,
          state: 'active',
          topicId: id,
          keyword: current.keyword,
          normalizedKeyword: current.normalizedKeyword,
        },
        occurredAt: new Date(),
      });
      return this.queueRefreshInTransaction(transaction, userId, id);
    });
  }

  async deleteTopic(userId: string, id: string): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.topic.findFirst({
        where: { id, userId, deletedAt: null },
      });
      if (!current) return false;
      const deletedAt = new Date();
      const active = await transaction.topic.updateMany({
        where: { id, userId, deletedAt: null, activeRunId: { not: null } },
        data: { deletedAt, nextRunAt: null, queuedTrigger: null, manualRefreshPending: false },
      });
      if (active.count === 0) {
        const inactive = await transaction.topic.updateMany({
          where: { id, userId, deletedAt: null, activeRunId: null },
          data: {
            deletedAt, nextRunAt: null, runStatus: 'failed', queuedTrigger: null,
            runLeaseUntil: null, manualRefreshPending: false,
          },
        });
        if (inactive.count !== 1) return false;
      }
      await this.topicDispatchOutbox.cancelTopic(id, transaction);
      await appendInterestEvent(transaction, {
        userId,
        eventType: 'topic_state',
        sourceRef: id,
        payload: {
          schemaVersion: 1,
          state: 'deleted',
          topicId: id,
          keyword: current.keyword,
          normalizedKeyword: current.normalizedKeyword,
        },
        occurredAt: deletedAt,
      });
      return true;
    });
  }

  async compensateTopicRefresh(userId: string, id: string): Promise<boolean> {
    const compensated = await this.prisma.topic.updateMany({
      where: {
        id, userId, deletedAt: null, activeRunId: null,
        runStatus: 'queued', queuedTrigger: { in: ['initial', 'manual'] },
      },
      data: { runStatus: 'failed', queuedTrigger: null, lastError: TOPIC_QUEUE_ERROR },
    });
    return compensated.count === 1;
  }

  async queueRefresh(userId: string, id: string): Promise<QueueRefreshResult | null> {
    return this.prisma.$transaction((transaction) => this.queueRefreshInTransaction(
      transaction, userId, id,
    ));
  }

  async listFeed(
    userId: string,
    filter: FeedStoreFilter,
  ): Promise<FeedPage> {
    const pagination = paginationContext(
      userId, filter, filter.snapshotAt ?? new Date(), this.cursorSecret,
    );
    const savedContent = filter.reading
      ? await this.savedContentKeys(userId, filter.reading, pagination.snapshotAt)
      : null;
    if (filter.reading && savedContent!.keys.length === 0) {
      return feedPage([], pagination, savedContent!.truncated, this.cursorSecret);
    }
    const savedWhere = savedContent
      ? { canonicalPrimaryUrl: { in: savedContent.keys } }
      : {};
    const includeTopics = filter.origin === 'all' || filter.origin === 'topic';
    const includeTrends = !filter.topicId && (filter.origin === 'all' || filter.origin === 'trend');
    const includeCreators = !filter.topicId && (filter.origin === 'all' || filter.origin === 'creator');
    const timeWhere = {
      discoveredAt: { lte: pagination.snapshotAt },
      ...(pagination.since ? {
        OR: [
          { publishedAt: { gte: pagination.since } },
          { publishedAt: null, discoveredAt: { gte: pagination.since } },
        ],
      } : {}),
    };
    if (filter.query) {
      const searchFilter = {
        ...filter,
        since: pagination.since,
        snapshotAt: pagination.snapshotAt,
        limit: FEED_SOURCE_CANDIDATE_LIMIT,
        query: filter.query,
        ...(savedContent ? { contentKeys: savedContent.keys } : {}),
      };
      const topicRankPromise = !includeTopics
        ? Promise.resolve([] as RankedId[])
        : this.prisma.$queryRaw<RankedId[]>(buildTopicRankQuery(userId, searchFilter));
      const radarRankPromise = !includeTrends
        ? Promise.resolve([] as RankedId[])
        : this.prisma.$queryRaw<RankedId[]>(buildTrendRankQuery(userId, searchFilter));
      const creatorPromise = includeCreators
        ? this.prisma.creatorItem.findMany({
            where: {
              userId,
              feedEligible: true,
              ...savedWhere,
              ...(filter.kind ? { kind: filter.kind } : {}),
              ...timeWhere,
              creator: { cancelledAt: null },
            },
            include: { creator: { select: { displayName: true } } },
            orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
            take: FEED_SOURCE_CANDIDATE_LIMIT,
          })
        : Promise.resolve([]);
      const [topicRanks, radarRanks, creatorItems] = await Promise.all([
        topicRankPromise,
        radarRankPromise,
        creatorPromise,
      ]);
      const topicRankById = new Map(topicRanks.map((rank) => [rank.id, rank.relevance]));
      const radarRankById = new Map(radarRanks.map((rank) => [rank.id, rank.relevance]));
      const [topicItems, radarItems] = await Promise.all([
        topicRanks.length === 0
          ? Promise.resolve([] as PrismaDiscoveryItem[])
          : this.prisma.discoveryItem.findMany({
              where: {
                id: { in: topicRanks.map(({ id }) => id) },
                ...savedWhere,
                ...(filter.kind ? { kind: filter.kind } : {}),
                ...timeWhere,
                topic: {
                  userId,
                  ...(filter.topicId ? { id: filter.topicId } : {}),
                },
              },
              include: { topic: { select: { deletedAt: true, keyword: true } } },
            }),
        radarRanks.length === 0
          ? Promise.resolve([] as PrismaRadarItem[])
          : this.prisma.radarItem.findMany({
              where: {
                id: { in: radarRanks.map(({ id }) => id) },
                userId,
                ...savedWhere,
                ...(filter.kind ? { kind: filter.kind } : {}),
                ...timeWhere,
              },
            }),
      ]);
      const feed = await this.attachFeedback(userId, mergeFeedItems(sortRankedFeed([
        ...topicItems.map((item) => ({
          item: mapTopicFeedItem(item),
          relevance: topicRankById.get(item.id) ?? 0,
        })),
        ...radarItems.map((item) => ({
          item: mapRadarFeedItem(item),
          relevance: radarRankById.get(item.id) ?? 0,
        })),
        ...creatorItems.flatMap((item) => {
          const feedItem = mapCreatorFeedItem(item);
          const relevance = memorySearchRelevance(feedItem, filter.query!);
          return relevance === null ? [] : [{ item: feedItem, relevance }];
        }),
      ])));
      return feedPage(feed, pagination, [
        topicRanks.length,
        radarRanks.length,
        creatorItems.length,
      ].some((count) => count === FEED_SOURCE_CANDIDATE_LIMIT) || savedContent?.truncated === true, this.cursorSecret);
    }
    const topicPromise = !includeTopics
      ? Promise.resolve([] as PrismaDiscoveryItem[])
      : this.prisma.discoveryItem.findMany({
          where: {
            ...savedWhere,
            ...(filter.kind ? { kind: filter.kind } : {}),
            ...timeWhere,
            topic: {
              userId,
              ...(filter.topicId ? { id: filter.topicId } : {}),
            },
          },
          include: { topic: { select: { deletedAt: true, keyword: true } } },
          orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
          take: FEED_SOURCE_CANDIDATE_LIMIT,
        });
    const radarPromise = !includeTrends
      ? Promise.resolve([] as PrismaRadarItem[])
      : this.prisma.radarItem.findMany({
          where: {
            userId,
            ...savedWhere,
            ...(filter.kind ? { kind: filter.kind } : {}),
            ...timeWhere,
          },
          orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
          take: FEED_SOURCE_CANDIDATE_LIMIT,
        });
    const creatorPromise = !includeCreators
      ? Promise.resolve([])
      : this.prisma.creatorItem.findMany({
          where: {
            userId,
            feedEligible: true,
            ...savedWhere,
            ...(filter.kind ? { kind: filter.kind } : {}),
            ...timeWhere,
            creator: { cancelledAt: null },
          },
          include: { creator: { select: { displayName: true } } },
          orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
          take: FEED_SOURCE_CANDIDATE_LIMIT,
        });
    const [topicItems, radarItems, creatorItems] = await Promise.all([
      topicPromise,
      radarPromise,
      creatorPromise,
    ]);
    const feed = await this.attachFeedback(userId, mergeFeedItems(sortFeed([
      ...topicItems.map(mapTopicFeedItem),
      ...radarItems.map(mapRadarFeedItem),
      ...creatorItems.map(mapCreatorFeedItem),
    ])));
    const personalized = await this.personalizeFeed(userId, feed, pagination.snapshotAt);
    return feedPage(personalized, pagination, [
      topicItems.length,
      radarItems.length,
      creatorItems.length,
    ].some((count) => count === FEED_SOURCE_CANDIDATE_LIMIT) || savedContent?.truncated === true, this.cursorSecret);
  }

  async setFeedback(
    userId: string,
    contentKey: string,
    value: FeedbackValue | null,
  ): Promise<ContentFeedback | null> {
    const canonicalContentKey = canonicalizeUrl(contentKey);
    return this.prisma.$transaction(async (transaction) => {
      const [topicItem, radarItem, creatorItem] = await Promise.all([
        transaction.discoveryItem.findFirst({
          where: { canonicalPrimaryUrl: canonicalContentKey, topic: { userId } },
          select: { id: true },
        }),
        transaction.radarItem.findFirst({
          where: { userId, canonicalPrimaryUrl: canonicalContentKey },
          select: { id: true },
        }),
        transaction.creatorItem.findFirst({
          where: {
            userId,
            canonicalPrimaryUrl: canonicalContentKey,
            feedEligible: true,
            creator: { cancelledAt: null },
          },
          select: { id: true },
        }),
      ]);
      if (!topicItem && !radarItem && !creatorItem) return null;

      const current = await transaction.contentFeedback.findUnique({
        where: { userId_contentKey: { userId, contentKey: canonicalContentKey } },
        select: { value: true },
      });
      if ((current?.value ?? null) === value) {
        return contentFeedbackSchema.parse({ contentKey: canonicalContentKey, value });
      }
      const occurredAt = new Date();
      if (value === null) {
        await transaction.contentFeedback.deleteMany({
          where: { userId, contentKey: canonicalContentKey },
        });
      } else {
        await transaction.contentFeedback.upsert({
          where: { userId_contentKey: { userId, contentKey: canonicalContentKey } },
          create: { userId, contentKey: canonicalContentKey, value },
          update: { value },
        });
      }
      await appendInterestEvent(transaction, {
        userId,
        eventType: 'feedback_state',
        sourceRef: canonicalContentKey,
        payload: {
          schemaVersion: 1,
          state: value,
          contentKey: canonicalContentKey,
        },
        occurredAt,
      });
      return contentFeedbackSchema.parse({ contentKey: canonicalContentKey, value });
    });
  }

  private async setSavedContentInTransaction(
    transaction: Prisma.TransactionClient,
    userId: string,
    canonicalContentKey: string,
    state: ReadingState | null,
    changedAt: Date,
  ): Promise<SavedContent | null> {
    const [topicItem, radarItem, creatorItem] = await Promise.all([
      transaction.discoveryItem.findFirst({
        where: { canonicalPrimaryUrl: canonicalContentKey, topic: { userId } },
        select: { id: true },
      }),
      transaction.radarItem.findFirst({
        where: { userId, canonicalPrimaryUrl: canonicalContentKey },
        select: { id: true },
      }),
      transaction.creatorItem.findFirst({
        where: {
          userId,
          canonicalPrimaryUrl: canonicalContentKey,
          feedEligible: true,
          creator: { cancelledAt: null },
        },
        select: { id: true },
      }),
    ]);
    if (!topicItem && !radarItem && !creatorItem) return null;

    const current = await transaction.savedContent.findFirst({
      where: { userId, contentKey: canonicalContentKey, removedAt: null },
      select: { state: true },
    });
    if (current?.state === state || (!current && state === null)) {
      return savedContentSchema.parse({ contentKey: canonicalContentKey, state });
    }

    if (current) {
      await transaction.savedContent.updateMany({
        where: { userId, contentKey: canonicalContentKey, removedAt: null },
        data: { removedAt: changedAt },
      });
    }
    if (state !== null) {
      await transaction.savedContent.create({
        data: {
          userId,
          contentKey: canonicalContentKey,
          state,
          savedAt: changedAt,
        },
      });
    }
    return savedContentSchema.parse({ contentKey: canonicalContentKey, state });
  }

  async setSavedContent(
    userId: string,
    contentKey: string,
    state: ReadingState | null,
  ): Promise<SavedContent | null> {
    const canonicalContentKey = canonicalizeUrl(contentKey);
    return this.prisma.$transaction((transaction) => this.setSavedContentInTransaction(
      transaction,
      userId,
      canonicalContentKey,
      state,
      new Date(),
    ));
  }

  async setSavedContentBatch(
    userId: string,
    contentKeys: string[],
    state: 'archived',
  ): Promise<SavedContent[] | null> {
    const canonicalContentKeys = contentKeys.map((contentKey) => canonicalizeUrl(contentKey));
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const changedAt = new Date();
        const results: SavedContent[] = [];
        for (const canonicalContentKey of canonicalContentKeys) {
          const result = await this.setSavedContentInTransaction(
            transaction,
            userId,
            canonicalContentKey,
            state,
            changedAt,
          );
          if (!result) throw new SavedContentBatchTargetNotFoundError();
          results.push(result);
        }
        return results;
      });
    } catch (error) {
      if (error instanceof SavedContentBatchTargetNotFoundError) return null;
      throw error;
    }
  }

  async recordFeedImpressions(
    userId: string,
    input: FeedImpressionInput,
  ): Promise<FeedImpressionReceipt | null> {
    const contentKeys = [...new Set(input.contentKeys.map((key) => canonicalizeUrl(key)))];
    return this.prisma.$transaction(async (transaction) => {
      const decision = await transaction.recommendationDecision.findFirst({
        where: { id: input.decisionId, userId, surface: 'feed' },
        include: {
          items: {
            where: { contentKey: { in: contentKeys } },
            select: { contentKey: true, position: true },
          },
        },
      });
      if (!decision || decision.items.length !== contentKeys.length) return null;

      const now = new Date();
      const bucketStart = new Date(now);
      bucketStart.setUTCSeconds(0, 0);
      const positions = new Map(decision.items.map((item) => [item.contentKey, item.position]));
      const result = await transaction.feedImpression.createMany({
        data: contentKeys.map((contentKey) => ({
          userId,
          decisionId: decision.id,
          contentKey,
          position: positions.get(contentKey)!,
          surface: 'feed' as const,
          bucketStart,
          shownAt: now,
        })),
        skipDuplicates: true,
      });
      return { recorded: result.count };
    });
  }

  async listInterestEvents(userId: string): Promise<InterestEvent[]> {
    const events = await this.prisma.interestEvent.findMany({
      where: { userId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    return events.map(mapInterestEvent);
  }

  async findItem(userId: string, id: string): Promise<FeedItem | null> {
    const item = await this.prisma.discoveryItem.findFirst({
      where: { id, topic: { userId } },
      include: { topic: { select: { deletedAt: true, keyword: true } } },
    });
    if (item) return (await this.attachFeedback(userId, [mapTopicFeedItem(item)]))[0]!;
    const radar = await this.prisma.radarItem.findFirst({ where: { id, userId } });
    if (radar) return (await this.attachFeedback(userId, [mapRadarFeedItem(radar)]))[0]!;
    const creatorItem = await this.prisma.creatorItem.findFirst({
      where: { id, userId, feedEligible: true, creator: { cancelledAt: null } },
      include: { creator: { select: { displayName: true } } },
    });
    return creatorItem
      ? (await this.attachFeedback(userId, [mapCreatorFeedItem(creatorItem)]))[0]!
      : null;
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
        const activeRun = monitor.activeRunId === null
          ? null
          : await transaction.trendRun.findUnique({
              where: { id_userId: { id: monitor.activeRunId, userId } },
              select: { trigger: true, status: true },
            });
        if (active && activeRun?.trigger === 'manual' && activeRun.status === 'queued') {
          return {
            status: mapTrendStatus(monitor), shouldEnqueue: false, registration: null,
          };
        }
        const previousError = safeErrorSchema.safeParse(monitor.lastError);
        if (active) {
          const updated = await transaction.trendMonitor.updateMany({
            where: {
              id: monitor.id, userId, manualRefreshPending: false,
              activeRunId: monitor.activeRunId,
              runLeaseUntil: { gt: now },
              runStatus: { in: ['queued', 'running'] },
            },
            data: { manualRefreshPending: true, lastError: Prisma.DbNull },
          });
          monitor = await transaction.trendMonitor.findUniqueOrThrow({
            where: { userId }, include: latestRunInclude,
          });
          if (updated.count === 1) {
            return {
              status: mapTrendStatus(monitor), shouldEnqueue: false, registration: null,
            };
          }
          continue;
        }

        const runId = randomUUID();
        const registrationUntil = new Date(now.getTime() + TREND_QUEUE_REGISTRATION_MS);
        const registration: TrendRefreshRegistration = {
          monitorId: monitor.id,
          runId,
          registrationUntil,
          previousActiveRunId: monitor.activeRunId,
          previousRunLeaseUntil: monitor.runLeaseUntil,
          previousRunStatus: monitor.runStatus,
          previousLastError: previousError.success ? previousError.data : null,
          previousLastRun: mapRunSummary(monitor.runs?.[0]),
        };
        const updated = await transaction.trendMonitor.updateMany({
          where: {
            id: monitor.id, userId, manualRefreshPending: false,
            activeRunId: monitor.activeRunId,
            runLeaseUntil: monitor.runLeaseUntil,
            runStatus: monitor.runStatus,
          },
          data: {
            activeRunId: runId,
            runLeaseUntil: registrationUntil,
            runStatus: 'queued',
            manualRefreshPending: false,
            lastError: Prisma.DbNull,
          },
        });
        if (updated.count !== 1) {
          monitor = await transaction.trendMonitor.findUniqueOrThrow({
            where: { userId }, include: latestRunInclude,
          });
          continue;
        }
        if (monitor.activeRunId) {
          await transaction.trendRun.updateMany({
            where: {
              id: monitor.activeRunId, userId, status: { in: ['queued', 'running'] },
            },
            data: {
              status: 'failed', finishedAt: now,
              error: { code: 'TREND_RUN_LEASE_EXPIRED', message: 'Trend run lease expired' },
            },
          });
        }
        await transaction.trendRun.create({
          data: {
            id: runId, userId, monitorId: monitor.id,
            trigger: 'manual', status: 'queued', startedAt: now,
          },
        });
        monitor = await transaction.trendMonitor.findUniqueOrThrow({
          where: { userId }, include: latestRunInclude,
        });
        return {
          status: mapTrendStatus(monitor), shouldEnqueue: true, registration,
        };
      }
    });
  }

  async compensateTrendRefresh(
    userId: string,
    registration: TrendRefreshRegistration,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const compensated = await transaction.trendMonitor.updateMany({
        where: {
          id: registration.monitorId,
          userId,
          manualRefreshPending: false,
          runStatus: 'queued',
          activeRunId: registration.runId,
          runLeaseUntil: registration.registrationUntil,
        },
        data: {
          activeRunId: registration.previousActiveRunId,
          runLeaseUntil: registration.previousRunLeaseUntil,
          runStatus: registration.previousRunStatus,
          lastError: registration.previousLastError ?? Prisma.DbNull,
        },
      });
      if (compensated.count !== 1) return false;
      await transaction.trendRun.deleteMany({
        where: {
          id: registration.runId, userId, monitorId: registration.monitorId,
          trigger: 'manual', status: 'queued',
        },
      });
      return true;
    });
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async healthCheck(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}

export class MemoryTopicStore implements TopicStore {
  private readonly topics: Array<Topic & { deletedAt: string | null; variantsInitialized: boolean }> = [];
  private readonly creators: Array<Creator & { cancelledAt: string | null; accountKey: string }> = [];
  private readonly creatorItems: Array<CreatorItem & { userId: string; creatorName: string }> = [];
  private readonly items: Array<DiscoveryItem & { topicKeyword: string }> = [];
  private readonly radarItems: Array<TrendFeedItem & { userId: string }> = [];
  private readonly feedback = new Map<string, FeedbackValue>();
  private readonly savedContent: Array<{
    userId: string;
    contentKey: string;
    state: ReadingState;
    savedAt: string;
    removedAt: string | null;
  }> = [];
  private readonly feedDecisions = new Map<string, Set<string>>();
  private readonly feedImpressions = new Set<string>();
  private readonly interestEvents: InterestEvent[] = [];
  private readonly pendingManualRefreshes = new Set<string>();
  private readonly trendMonitors = new Map<string, TrendStatus & {
    manualRefreshPending: boolean;
    activeRunId: string | null;
    runLeaseUntil: Date | null;
  }>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly personalization?: PersonalizationMemory,
    private readonly cursorSecret = LOCAL_FEED_CURSOR_SECRET,
    topicDispatchOutbox?: TopicDispatchOutbox,
  ) {
    this.topicDispatchOutbox = topicDispatchOutbox ?? new MemoryTopicDispatchOutbox(
      now,
      (topicId) => {
        const topic = this.topics.find((candidate) => candidate.id === topicId);
        return topic?.deletedAt === null && topic.pausedAt === null;
      },
    );
  }

  public readonly topicDispatchOutbox: TopicDispatchOutbox;

  private async personalizeFeed(
    userId: string,
    items: FeedItem[],
    asOf: Date,
  ): Promise<FeedItem[]> {
    if (!this.personalization || items.length === 0) return items;
    try {
      const selection = await this.personalization.select({
        userId,
        surface: 'feed',
        candidates: items,
        asOf,
      });
      if (!selection.personalizationEnabled) return items;
      this.rememberFeedDecision(userId, selection.decisionId, selection.ranked.map((item) => item.contentKey));
      const itemByKey = new Map(items.map((item) => [item.contentKey, item]));
      const personalized = selection.ranked.flatMap((ranked) => {
        const item = itemByKey.get(ranked.contentKey);
        if (!item) return [];
        itemByKey.delete(ranked.contentKey);
        return [{ ...item, recommendation: publicRecommendation(ranked, selection.decisionId) }];
      });
      return [...personalized, ...itemByKey.values()];
    } catch {
      return items;
    }
  }

  private feedbackKey(userId: string, contentKey: string): string {
    return `${userId}\u0000${canonicalizeUrl(contentKey)}`;
  }

  private attachFeedback(userId: string, items: FeedItem[]): FeedItem[] {
    return items.map((item) => ({
      ...item,
      feedback: this.feedback.get(this.feedbackKey(userId, item.contentKey)) ?? null,
      readingState: this.savedContent.find((row) => (
        row.userId === userId
        && row.contentKey === canonicalizeUrl(item.contentKey)
        && row.removedAt === null
      ))?.state ?? null,
    }));
  }

  private savedContentKeys(
    userId: string,
    state: ReadingState,
    snapshotAt: string,
  ): { keys: Set<string>; truncated: boolean } {
    const rows = this.savedContent
      .filter((row) => (
        row.userId === userId
        && row.state === state
        && row.savedAt <= snapshotAt
        && (row.removedAt === null || row.removedAt > snapshotAt)
      ))
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt) || right.contentKey.localeCompare(left.contentKey));
    return {
      keys: new Set(rows.slice(0, FEED_SOURCE_CANDIDATE_LIMIT).map((row) => row.contentKey)),
      truncated: rows.length > FEED_SOURCE_CANDIDATE_LIMIT,
    };
  }

  async createTopic(
    userId: string,
    keyword: string,
    normalizedKeyword: string,
  ): Promise<Topic> {
    if (
      this.topics.some(
        (topic) =>
          topic.userId === userId && topic.deletedAt === null && normalizeKeyword(topic.keyword) === normalizedKeyword,
      )
    ) {
      throw new TopicAlreadyExistsError();
    }
    const startedAt = this.now().toISOString();
    const topic: Topic & { deletedAt: string | null; variantsInitialized: boolean } = {
      id: randomUUID(),
      userId,
      keyword,
      expandedTerms: [],
      createdAt: startedAt,
      pausedAt: null,
      lastRunAt: null,
      nextRunAt: null,
      scheduleIntervalHours: 12,
      runStatus: 'queued',
      lastError: null,
      lastRun: {
        id: randomUUID(), trigger: 'initial', status: 'queued', startedAt,
        finishedAt: null, newItemCount: null,
      },
      deletedAt: null,
      variantsInitialized: false,
    };
    this.topics.unshift(topic);
    await this.topicDispatchOutbox.register({ topicId: topic.id, userId, trigger: 'initial' });
    appendMemoryInterestEvent(this.interestEvents, {
      userId,
      eventType: 'topic_state',
      sourceRef: topic.id,
      payload: {
        schemaVersion: 1,
        state: 'active',
        topicId: topic.id,
        keyword,
        normalizedKeyword,
      },
      occurredAt: this.now(),
    });
    return structuredClone(topic);
  }

  async createCreator(userId: string, input: CreatorCreateInput): Promise<Creator> {
    return (await this.createCreators(userId, [input]))[0]!;
  }

  async createCreators(userId: string, inputs: CreatorCreateInput[]): Promise<Creator[]> {
    if (inputs.length === 0) return [];
    const inputKeys = new Set(inputs.map((input) => `${input.platform}:${input.accountKey}`));
    if (inputKeys.size !== inputs.length) throw new CreatorAlreadyExistsError();
    const existingCreators = inputs.map((input) => this.creators.find((creator) => (
      creator.userId === userId && creator.platform === input.platform && creator.accountKey === input.accountKey
    )));
    if (existingCreators.some((creator) => creator?.cancelledAt === null)) {
      throw new CreatorAlreadyExistsError();
    }
    const results: Creator[] = [];
    for (const [index, input] of inputs.entries()) {
      const existing = existingCreators[index];
      const now = this.now().toISOString();
      if (existing) {
        Object.assign(existing, {
          displayName: input.displayName,
          profileUrl: input.profileUrl,
          feedUrl: input.feedUrl,
          cancelledAt: null,
          pausedAt: null,
          nextRunAt: null,
          runStatus: 'queued' as const,
          lastError: null,
        });
        appendMemoryInterestEvent(this.interestEvents, {
          userId,
          eventType: 'creator_state',
          sourceRef: existing.id,
          payload: {
            schemaVersion: 1,
            state: 'active',
            creatorId: existing.id,
            platform: existing.platform,
            accountKey: existing.accountKey,
            displayName: existing.displayName,
          },
          occurredAt: this.now(),
        });
        results.push(structuredClone(existing));
        continue;
      }
      const creator: Creator & { cancelledAt: string | null; accountKey: string } = {
        id: randomUUID(),
        userId,
        platform: input.platform,
        displayName: input.displayName,
        profileUrl: input.profileUrl,
        feedUrl: input.feedUrl,
        createdAt: now,
        pausedAt: null,
        lastRunAt: null,
        nextRunAt: null,
        runStatus: 'queued',
        lastError: null,
        degradedSources: [],
        lastRun: null,
        cancelledAt: null,
        accountKey: input.accountKey,
      };
      this.creators.unshift(creator);
      appendMemoryInterestEvent(this.interestEvents, {
        userId,
        eventType: 'creator_state',
        sourceRef: creator.id,
        payload: {
          schemaVersion: 1,
          state: 'active',
          creatorId: creator.id,
          platform: creator.platform,
          accountKey: creator.accountKey,
          displayName: creator.displayName,
        },
        occurredAt: this.now(),
      });
      results.push(structuredClone(creator));
    }
    return results;
  }

  async listCreators(userId: string): Promise<Creator[]> {
    return this.creators
      .filter((creator) => creator.userId === userId && creator.cancelledAt === null)
      .map((creator) => structuredClone(creator));
  }

  async findCreator(userId: string, id: string): Promise<Creator | null> {
    const creator = this.creators.find((candidate) => (
      candidate.userId === userId && candidate.id === id && candidate.cancelledAt === null
    ));
    return creator ? structuredClone(creator) : null;
  }

  async updateCreator(userId: string, id: string, input: CreatorUpdate): Promise<Creator | null> {
    const creator = this.creators.find((candidate) => (
      candidate.userId === userId && candidate.id === id && candidate.cancelledAt === null
    ));
    if (!creator) return null;
    const alreadyInState = input.paused ? creator.pausedAt !== null : creator.pausedAt === null;
    if (alreadyInState) return structuredClone(creator);
    const occurredAt = this.now();
    if (input.paused) {
      creator.pausedAt = occurredAt.toISOString();
      creator.nextRunAt = null;
    } else {
      creator.pausedAt = null;
      creator.nextRunAt = this.now().toISOString();
      creator.runStatus = 'succeeded';
      creator.lastError = null;
      creator.degradedSources = [];
    }
    appendMemoryInterestEvent(this.interestEvents, {
      userId,
      eventType: 'creator_state',
      sourceRef: creator.id,
      payload: {
        schemaVersion: 1,
        state: input.paused ? 'paused' : 'active',
        creatorId: creator.id,
        platform: creator.platform,
        accountKey: creator.accountKey,
        displayName: creator.displayName,
      },
      occurredAt,
    });
    return structuredClone(creator);
  }

  async deleteCreator(userId: string, id: string): Promise<boolean> {
    const creator = this.creators.find((candidate) => (
      candidate.userId === userId && candidate.id === id && candidate.cancelledAt === null
    ));
    if (!creator) return false;
    const occurredAt = this.now();
    creator.cancelledAt = occurredAt.toISOString();
    creator.pausedAt = creator.cancelledAt;
    creator.nextRunAt = null;
    appendMemoryInterestEvent(this.interestEvents, {
      userId,
      eventType: 'creator_state',
      sourceRef: creator.id,
      payload: {
        schemaVersion: 1,
        state: 'cancelled',
        creatorId: creator.id,
        platform: creator.platform,
        accountKey: creator.accountKey,
        displayName: creator.displayName,
      },
      occurredAt,
    });
    return true;
  }

  async queueCreatorRefresh(userId: string, id: string): Promise<CreatorQueueResult | null> {
    const creator = this.creators.find((candidate) => (
      candidate.userId === userId && candidate.id === id && candidate.cancelledAt === null
    ));
    if (!creator) return null;
    if (creator.pausedAt) return { creator: structuredClone(creator), shouldEnqueue: false };
    if (creator.runStatus === 'queued' && creator.lastRun === null) {
      return { creator: structuredClone(creator), shouldEnqueue: true };
    }
    if (creator.runStatus === 'running' || creator.runStatus === 'queued') {
      return { creator: structuredClone(creator), shouldEnqueue: false };
    }
    creator.runStatus = 'queued';
    creator.lastError = null;
    creator.degradedSources = [];
    return { creator: structuredClone(creator), shouldEnqueue: true };
  }

  async compensateCreatorRefresh(userId: string, id: string): Promise<boolean> {
    const creator = this.creators.find((candidate) => (
      candidate.userId === userId && candidate.id === id && candidate.cancelledAt === null
        && candidate.runStatus === 'queued'
    ));
    if (!creator) return false;
    creator.runStatus = 'failed';
    creator.lastError = { code: 'CREATOR_QUEUE_UNAVAILABLE', message: '博主任务暂时无法入队，请稍后重试' };
    return true;
  }

  async listCreatorItems(userId: string, id: string): Promise<CreatorItem[] | null> {
    const creator = this.creators.find((candidate) => candidate.userId === userId && candidate.id === id);
    if (!creator) return null;
    return this.creatorItems
      .filter((item) => item.userId === userId && item.creatorId === id)
      .map(({ userId: _userId, creatorName: _creatorName, ...item }) => structuredClone(item));
  }

  async listTopics(userId: string): Promise<Topic[]> {
    return this.topics
      .filter((topic) => topic.userId === userId && topic.deletedAt === null)
      .map((topic) => structuredClone(topic));
  }

  async findTopic(userId: string, id: string): Promise<Topic | null> {
    const topic = this.topics.find((candidate) => candidate.userId === userId && candidate.id === id && candidate.deletedAt === null);
    return topic ? structuredClone(topic) : null;
  }

  async updateTopic(userId: string, id: string, input: TopicUpdate): Promise<QueueRefreshResult | null> {
    const topic = this.topics.find((candidate) => candidate.userId === userId && candidate.id === id && candidate.deletedAt === null);
    if (!topic) return null;
    if (this.topics.some((candidate) => candidate !== topic && candidate.userId === userId && candidate.deletedAt === null && normalizeKeyword(candidate.keyword) === input.normalizedKeyword)) {
      throw new TopicAlreadyExistsError();
    }
    topic.keyword = input.keyword;
    topic.expandedTerms = [];
    topic.variantsInitialized = false;
    topic.nextRunAt = null;
    topic.lastError = null;
    appendMemoryInterestEvent(this.interestEvents, {
      userId,
      eventType: 'topic_state',
      sourceRef: topic.id,
      payload: {
        schemaVersion: 1,
        state: 'active',
        topicId: topic.id,
        keyword: topic.keyword,
        normalizedKeyword: input.normalizedKeyword,
      },
      occurredAt: this.now(),
    });
    return this.queueRefresh(userId, id);
  }

  async pauseTopic(userId: string, id: string): Promise<Topic | null> {
    const topic = this.topics.find(
      (candidate) => candidate.userId === userId && candidate.id === id && candidate.deletedAt === null,
    );
    if (!topic) return null;
    if (topic.pausedAt) return structuredClone(topic);
    const occurredAt = this.now();
    topic.pausedAt = occurredAt.toISOString();
    topic.nextRunAt = null;
    this.pendingManualRefreshes.delete(id);
    appendMemoryInterestEvent(this.interestEvents, {
      userId,
      eventType: 'topic_state',
      sourceRef: topic.id,
      payload: {
        schemaVersion: 1,
        state: 'paused',
        topicId: topic.id,
        keyword: topic.keyword,
        normalizedKeyword: normalizeKeyword(topic.keyword),
      },
      occurredAt,
    });
    return structuredClone(topic);
  }

  async resumeTopic(userId: string, id: string): Promise<QueueRefreshResult | null> {
    const topic = this.topics.find(
      (candidate) => candidate.userId === userId && candidate.id === id && candidate.deletedAt === null,
    );
    if (!topic) return null;
    const occurredAt = this.now();
    topic.pausedAt = null;
    appendMemoryInterestEvent(this.interestEvents, {
      userId,
      eventType: 'topic_state',
      sourceRef: topic.id,
      payload: {
        schemaVersion: 1,
        state: 'active',
        topicId: topic.id,
        keyword: topic.keyword,
        normalizedKeyword: normalizeKeyword(topic.keyword),
      },
      occurredAt,
    });
    return this.queueRefresh(userId, id);
  }

  async deleteTopic(userId: string, id: string): Promise<boolean> {
    const topic = this.topics.find((candidate) => candidate.userId === userId && candidate.id === id && candidate.deletedAt === null);
    if (!topic) return false;
    const occurredAt = this.now();
    topic.deletedAt = occurredAt.toISOString();
    topic.nextRunAt = null;
    if (topic.runStatus !== 'running') topic.runStatus = 'failed';
    await this.topicDispatchOutbox.cancelTopic(id);
    appendMemoryInterestEvent(this.interestEvents, {
      userId,
      eventType: 'topic_state',
      sourceRef: topic.id,
      payload: {
        schemaVersion: 1,
        state: 'deleted',
        topicId: topic.id,
        keyword: topic.keyword,
        normalizedKeyword: normalizeKeyword(topic.keyword),
      },
      occurredAt,
    });
    return true;
  }

  async compensateTopicRefresh(userId: string, id: string): Promise<boolean> {
    const topic = this.topics.find((candidate) => (
      candidate.userId === userId && candidate.id === id && candidate.deletedAt === null
    ));
    if (!topic || topic.runStatus !== 'queued') return false;
    topic.runStatus = 'failed';
    topic.lastError = TOPIC_QUEUE_ERROR;
    return true;
  }

  async queueRefresh(userId: string, id: string): Promise<QueueRefreshResult | null> {
    const topic = this.topics.find((candidate) => (
      candidate.userId === userId && candidate.id === id && candidate.deletedAt === null
    ));
    if (!topic) return null;
    if (topic.pausedAt) return { topic: structuredClone(topic), shouldEnqueue: false };
    if (topic.runStatus === 'running') {
      this.pendingManualRefreshes.add(id);
      topic.lastError = null;
      return { topic: structuredClone(topic), shouldEnqueue: false };
    }
    if (topic.runStatus === 'queued') {
      if (
        topic.lastRun?.status === 'queued'
        && (topic.lastRun.trigger === 'initial' || topic.lastRun.trigger === 'scheduled')
      ) {
        this.pendingManualRefreshes.add(id);
        topic.lastError = null;
      }
      return { topic: structuredClone(topic), shouldEnqueue: false };
    }
    topic.runStatus = 'queued';
    topic.lastError = null;
    await this.topicDispatchOutbox.register({ topicId: id, userId, trigger: 'manual' });
    return { topic: structuredClone(topic), shouldEnqueue: true };
  }

  async listFeed(
    userId: string,
    filter: FeedStoreFilter,
  ): Promise<FeedPage> {
    const pagination = paginationContext(
      userId, filter, filter.snapshotAt ?? this.now(), this.cursorSecret,
    );
    const snapshotAt = pagination.snapshotAt.toISOString();
    const savedContent = filter.reading
      ? this.savedContentKeys(userId, filter.reading, snapshotAt)
      : null;
    if (filter.reading && savedContent!.keys.size === 0) {
      return feedPage([], pagination, savedContent!.truncated, this.cursorSecret);
    }
    const retainSaved = <T extends FeedItem>(items: T[]): T[] => (
      savedContent ? items.filter((item) => savedContent.keys.has(canonicalizeUrl(item.contentKey))) : items
    );
    const topicIds = new Set(
      this.topics.filter((topic) => topic.userId === userId).map((topic) => topic.id),
    );
    const topicItems = filter.origin === 'trend' || filter.origin === 'creator' ? [] : this.items
      .filter(
        (item) =>
          topicIds.has(item.topicId) &&
          (!filter.topicId || item.topicId === filter.topicId) &&
          (!filter.kind || item.kind === filter.kind) &&
          item.discoveredAt <= snapshotAt &&
          (!pagination.since || (item.publishedAt ?? item.discoveredAt) >= pagination.since.toISOString()),
      )
      .map((item) => {
        const topic = this.topics.find((candidate) => candidate.id === item.topicId);
        const topicKeywordActive = topic?.deletedAt === null && topic.keyword === item.topicKeyword;
        return topicFeedItemSchema.parse({
          ...item, origin: 'topic',
          topicKeywordActive,
          contentKey: canonicalizeUrl(item.sourceUrls[0]!),
          feedback: null,
          origins: [{
            origin: 'topic',
            topicId: item.topicId,
            topicKeyword: item.topicKeyword,
            topicKeywordActive,
          }],
        });
      });
    const radarItems = filter.origin === 'topic' || filter.origin === 'creator' || filter.topicId ? [] : this.radarItems
      .filter((item) =>
        item.userId === userId &&
        (!filter.kind || item.kind === filter.kind) &&
        item.discoveredAt <= snapshotAt &&
        (!pagination.since || (item.publishedAt ?? item.discoveredAt) >= pagination.since.toISOString()))
      .map(({ userId: _userId, ...item }) => trendFeedItemSchema.parse(item));
    const creatorItems = filter.origin === 'topic' || filter.origin === 'trend' || filter.topicId
      ? []
      : this.creatorItems
          .filter((item) =>
            item.userId === userId &&
            item.feedEligible &&
            (!filter.kind || item.kind === filter.kind) &&
            item.discoveredAt <= snapshotAt &&
            (!pagination.since || (item.publishedAt ?? item.discoveredAt) >= pagination.since.toISOString()))
          .map(({ userId: _userId, creatorName, contentType,
            originalAuthorName: _originalAuthorName, originalAuthorHandle: _originalAuthorHandle,
            originalContentId: _originalContentId, originalContentUrl: _originalContentUrl,
            parentContentId: _parentContentId, parentContentUrl: _parentContentUrl,
            parentContentText: _parentContentText, ...item }) => creatorFeedItemSchema.parse({
            ...item,
            topicId: null,
            origin: 'creator',
            creatorName,
            feedEligible: true,
            contentKey: canonicalizeUrl(item.sourceUrls[0]!),
            feedback: null,
            origins: [{
              origin: 'creator',
              creatorId: item.creatorId,
              creatorName,
              platform: item.platform,
              contentType,
            }],
          }));
    const boundedTopicItems = sortFeed(retainSaved(topicItems)).slice(0, FEED_SOURCE_CANDIDATE_LIMIT);
    const boundedRadarItems = sortFeed(retainSaved(radarItems)).slice(0, FEED_SOURCE_CANDIDATE_LIMIT);
    const boundedCreatorItems = sortFeed(retainSaved(creatorItems)).slice(0, FEED_SOURCE_CANDIDATE_LIMIT);
    const truncated = [topicItems.length, radarItems.length, creatorItems.length]
      .some((count) => count >= FEED_SOURCE_CANDIDATE_LIMIT) || savedContent?.truncated === true;
    if (filter.query) {
      const feed = this.attachFeedback(userId, mergeFeedItems(sortRankedFeed([
        ...boundedTopicItems,
        ...boundedRadarItems,
        ...boundedCreatorItems,
      ].flatMap((item) => {
        const relevance = memorySearchRelevance(item, filter.query!);
        return relevance === null ? [] : [{ item, relevance }];
      })))).map((item) => structuredClone(item));
      return feedPage(feed, pagination, truncated, this.cursorSecret);
    }
    const feed = this.attachFeedback(
      userId,
      mergeFeedItems(sortFeed([
        ...boundedTopicItems,
        ...boundedRadarItems,
        ...boundedCreatorItems,
      ])),
    ).map((item) => structuredClone(item));
    const personalized = await this.personalizeFeed(userId, feed, pagination.snapshotAt);
    return feedPage(personalized, pagination, truncated, this.cursorSecret);
  }

  private rememberFeedDecision(userId: string, decisionId: string, contentKeys: string[]): void {
    this.feedDecisions.set(
      `${userId}\u0000${decisionId}`,
      new Set(contentKeys.map((key) => canonicalizeUrl(key))),
    );
  }

  async recordFeedImpressions(
    userId: string,
    input: FeedImpressionInput,
  ): Promise<FeedImpressionReceipt | null> {
    const allowed = this.feedDecisions.get(`${userId}\u0000${input.decisionId}`);
    const contentKeys = [...new Set(input.contentKeys.map((key) => canonicalizeUrl(key)))];
    if (!allowed || contentKeys.some((key) => !allowed.has(key))) return null;
    const bucketStart = new Date(this.now());
    bucketStart.setUTCSeconds(0, 0);
    let recorded = 0;
    for (const contentKey of contentKeys) {
      const impressionKey = [
        userId, input.decisionId, contentKey, bucketStart.toISOString(),
      ].join('\u0000');
      if (this.feedImpressions.has(impressionKey)) continue;
      this.feedImpressions.add(impressionKey);
      recorded += 1;
    }
    return { recorded };
  }

  async setFeedback(
    userId: string,
    contentKey: string,
    value: FeedbackValue | null,
  ): Promise<ContentFeedback | null> {
    const canonicalContentKey = canonicalizeUrl(contentKey);
    const ownsTopicItem = this.items.some((item) => (
      canonicalizeUrl(item.sourceUrls[0]!) === canonicalContentKey
      && this.topics.some((topic) => topic.id === item.topicId && topic.userId === userId)
    ));
    const ownsRadarItem = this.radarItems.some((item) => (
      item.userId === userId && canonicalizeUrl(item.contentKey) === canonicalContentKey
    ));
    const ownsCreatorItem = this.creatorItems.some((item) => (
      item.userId === userId
      && item.feedEligible
      && canonicalizeUrl(item.sourceUrls[0]!) === canonicalContentKey
      && this.creators.some((creator) => (
        creator.id === item.creatorId && creator.userId === userId && creator.cancelledAt === null
      ))
    ));
    if (!ownsTopicItem && !ownsRadarItem && !ownsCreatorItem) return null;

    const key = this.feedbackKey(userId, canonicalContentKey);
    const current = this.feedback.get(key) ?? null;
    if (current === value) return contentFeedbackSchema.parse({ contentKey: canonicalContentKey, value });
    if (value === null) this.feedback.delete(key);
    else this.feedback.set(key, value);
    appendMemoryInterestEvent(this.interestEvents, {
      userId,
      eventType: 'feedback_state',
      sourceRef: canonicalContentKey,
      payload: { schemaVersion: 1, state: value, contentKey: canonicalContentKey },
      occurredAt: this.now(),
    });
    return contentFeedbackSchema.parse({ contentKey: canonicalContentKey, value });
  }

  async setSavedContent(
    userId: string,
    contentKey: string,
    state: ReadingState | null,
  ): Promise<SavedContent | null> {
    const canonicalContentKey = canonicalizeUrl(contentKey);
    const ownsTopicItem = this.items.some((item) => (
      canonicalizeUrl(item.sourceUrls[0]!) === canonicalContentKey
      && this.topics.some((topic) => topic.id === item.topicId && topic.userId === userId)
    ));
    const ownsRadarItem = this.radarItems.some((item) => (
      item.userId === userId && canonicalizeUrl(item.contentKey) === canonicalContentKey
    ));
    const ownsCreatorItem = this.creatorItems.some((item) => (
      item.userId === userId
      && item.feedEligible
      && canonicalizeUrl(item.sourceUrls[0]!) === canonicalContentKey
      && this.creators.some((creator) => (
        creator.id === item.creatorId && creator.userId === userId && creator.cancelledAt === null
      ))
    ));
    if (!ownsTopicItem && !ownsRadarItem && !ownsCreatorItem) return null;

    const current = this.savedContent.find((row) => (
      row.userId === userId
      && row.contentKey === canonicalContentKey
      && row.removedAt === null
    ));
    if (current?.state === state || (!current && state === null)) {
      return savedContentSchema.parse({ contentKey: canonicalContentKey, state });
    }

    const changedAt = this.now().toISOString();
    if (current) current.removedAt = changedAt;
    if (state !== null) {
      this.savedContent.push({
        userId,
        contentKey: canonicalContentKey,
        state,
        savedAt: changedAt,
        removedAt: null,
      });
    }
    return savedContentSchema.parse({ contentKey: canonicalContentKey, state });
  }

  async setSavedContentBatch(
    userId: string,
    contentKeys: string[],
    state: 'archived',
  ): Promise<SavedContent[] | null> {
    const canonicalContentKeys = contentKeys.map((contentKey) => canonicalizeUrl(contentKey));
    const ownsContent = (canonicalContentKey: string) => (
      this.items.some((item) => (
        canonicalizeUrl(item.sourceUrls[0]!) === canonicalContentKey
        && this.topics.some((topic) => topic.id === item.topicId && topic.userId === userId)
      ))
      || this.radarItems.some((item) => (
        item.userId === userId && canonicalizeUrl(item.contentKey) === canonicalContentKey
      ))
      || this.creatorItems.some((item) => (
        item.userId === userId
        && item.feedEligible
        && canonicalizeUrl(item.sourceUrls[0]!) === canonicalContentKey
        && this.creators.some((creator) => (
          creator.id === item.creatorId && creator.userId === userId && creator.cancelledAt === null
        ))
      ))
    );
    if (!canonicalContentKeys.every(ownsContent)) return null;
    const results: SavedContent[] = [];
    for (const canonicalContentKey of canonicalContentKeys) {
      const result = await this.setSavedContent(userId, canonicalContentKey, state);
      if (!result) return null;
      results.push(result);
    }
    return results;
  }

  async listInterestEvents(userId: string): Promise<InterestEvent[]> {
    return this.interestEvents
      .filter((event) => event.userId === userId)
      .map((event) => structuredClone(event));
  }

  async findItem(userId: string, id: string): Promise<FeedItem | null> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item) {
      const ownsTopic = this.topics.some(
        (topic) => topic.id === item.topicId && topic.userId === userId,
      );
      const topic = this.topics.find((candidate) => candidate.id === item.topicId);
      return ownsTopic
          ? structuredClone(this.attachFeedback(userId, [topicFeedItemSchema.parse({
            ...item, origin: 'topic',
            topicKeywordActive: topic?.deletedAt === null && topic.keyword === item.topicKeyword,
            contentKey: canonicalizeUrl(item.sourceUrls[0]!),
            feedback: null,
            origins: [{
              origin: 'topic', topicId: item.topicId, topicKeyword: item.topicKeyword,
              topicKeywordActive: topic?.deletedAt === null && topic.keyword === item.topicKeyword,
            }],
          })])[0]!)
        : null;
    }
    const radar = this.radarItems.find(
      (candidate) => candidate.id === id && candidate.userId === userId,
    );
    if (radar) {
      const { userId: _userId, ...feedItem } = radar;
      return structuredClone(this.attachFeedback(userId, [trendFeedItemSchema.parse(feedItem)])[0]!);
    }
    const creatorItem = this.creatorItems.find(
      (candidate) => candidate.id === id && candidate.userId === userId && candidate.feedEligible,
    );
    if (!creatorItem) return null;
    const {
      userId: _userId,
      creatorName,
      contentType,
      originalAuthorName: _originalAuthorName,
      originalAuthorHandle: _originalAuthorHandle,
      originalContentId: _originalContentId,
      originalContentUrl: _originalContentUrl,
      parentContentId: _parentContentId,
      parentContentUrl: _parentContentUrl,
      parentContentText: _parentContentText,
      ...feedItem
    } = creatorItem;
    return structuredClone(this.attachFeedback(userId, [creatorFeedItemSchema.parse({
      ...feedItem,
      topicId: null,
      origin: 'creator',
      creatorName,
      feedEligible: true,
      contentKey: canonicalizeUrl(feedItem.sourceUrls[0]!),
      feedback: null,
      origins: [{
        origin: 'creator', creatorId: creatorItem.creatorId, creatorName,
        platform: creatorItem.platform, contentType,
      }],
    })])[0]!);
  }

  async getTrendStatus(
    userId: string,
    intervalHours: number,
    now = this.now(),
  ): Promise<TrendStatus> {
    const existing = this.trendMonitors.get(userId);
    if (existing) {
      const {
        manualRefreshPending: _pending,
        activeRunId: _activeRunId,
        runLeaseUntil: _runLeaseUntil,
        ...status
      } = existing;
      return structuredClone(trendStatusSchema.parse(status));
    }
    const monitor: TrendStatus & {
      manualRefreshPending: boolean;
      activeRunId: string | null;
      runLeaseUntil: Date | null;
    } = {
      runStatus: 'queued',
      nextRunAt: now.toISOString(),
      intervalHours,
      lastError: null,
      lastRun: null,
      manualRefreshPending: false,
      activeRunId: null,
      runLeaseUntil: null,
    };
    this.trendMonitors.set(userId, monitor);
    const {
      manualRefreshPending: _pending,
      activeRunId: _activeRunId,
      runLeaseUntil: _runLeaseUntil,
      ...status
    } = monitor;
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
      const {
        manualRefreshPending: _pending,
        activeRunId: _activeRunId,
        runLeaseUntil: _runLeaseUntil,
        ...status
      } = monitor;
      return {
        status: structuredClone(trendStatusSchema.parse(status)),
        shouldEnqueue: false,
        registration: null,
      };
    }
    const active = monitor.activeRunId !== null && monitor.runLeaseUntil !== null &&
      monitor.runLeaseUntil > now &&
      (monitor.runStatus === 'queued' || monitor.runStatus === 'running');
    if (active) {
      if (monitor.lastRun?.trigger !== 'manual') monitor.manualRefreshPending = true;
      monitor.lastError = null;
      const {
        manualRefreshPending: _pending,
        activeRunId: _activeRunId,
        runLeaseUntil: _runLeaseUntil,
        ...status
      } = monitor;
      return {
        status: structuredClone(trendStatusSchema.parse(status)),
        shouldEnqueue: false,
        registration: null,
      };
    }
    const runId = randomUUID();
    const registrationUntil = new Date(now.getTime() + TREND_QUEUE_REGISTRATION_MS);
    const registration: TrendRefreshRegistration = {
      monitorId: userId,
      runId,
      registrationUntil,
      previousActiveRunId: monitor.activeRunId,
      previousRunLeaseUntil: monitor.runLeaseUntil,
      previousRunStatus: monitor.runStatus,
      previousLastError: monitor.lastError,
      previousLastRun: monitor.lastRun,
    };
    monitor.manualRefreshPending = false;
    monitor.runStatus = 'queued';
    monitor.activeRunId = runId;
    monitor.runLeaseUntil = registrationUntil;
    monitor.lastError = null;
    monitor.lastRun = {
      id: runId, trigger: 'manual', status: 'queued', startedAt: now.toISOString(),
      finishedAt: null, newItemCount: null,
    };
    const {
      manualRefreshPending: _pending,
      activeRunId: _activeRunId,
      runLeaseUntil: _runLeaseUntil,
      ...status
    } = monitor;
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
      monitor.manualRefreshPending || monitor.runStatus !== 'queued' ||
      monitor.activeRunId !== registration.runId ||
      monitor.runLeaseUntil?.getTime() !== registration.registrationUntil.getTime() ||
      monitor.lastRun?.id !== registration.runId || monitor.lastRun.status !== 'queued'
    ) {
      return false;
    }
    monitor.activeRunId = registration.previousActiveRunId;
    monitor.runLeaseUntil = registration.previousRunLeaseUntil;
    monitor.runStatus = registration.previousRunStatus;
    monitor.lastError = registration.previousLastError;
    monitor.lastRun = registration.previousLastRun;
    return true;
  }

  seedTopic(userId: string, keyword: string): Topic {
    const topic: Topic & { deletedAt: string | null; variantsInitialized: boolean } = {
      id: randomUUID(),
      userId,
      keyword,
      expandedTerms: [],
      createdAt: new Date().toISOString(),
      pausedAt: null,
      lastRunAt: null,
      nextRunAt: null,
      scheduleIntervalHours: 12,
      runStatus: 'succeeded',
      lastError: null,
      lastRun: null,
      deletedAt: null,
      variantsInitialized: false,
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
      discoveredAt: timestamps.discoveredAt ?? this.now().toISOString(),
      sourceType: 'web',
      platform: 'Web',
      authorName: null,
      authorHandle: null,
      externalId: null,
      provenanceKind: 'ai_citation',
    };
    this.items.push({ ...item, topicKeyword: this.topics.find((topic) => topic.id === topicId)?.keyword ?? '' });
    return structuredClone(item);
  }

  seedDiscovery(userId: string, kind: DiscoveryKind): DiscoveryItem {
    const topic = this.seedTopic(userId, `${kind}-${randomUUID()}`);
    return this.seedItem(topic.id, kind);
  }

  seedRadarItem(
    userId: string,
    kind: DiscoveryKind,
    timestamps: { publishedAt?: string | null; discoveredAt?: string; sourceUrl?: string } = {},
  ): TrendFeedItem {
    const id = randomUUID();
    const sourceUrl = timestamps.sourceUrl ?? `https://example.com/radar/${id}`;
    const item = trendFeedItemSchema.parse({
      id,
      topicId: null,
      origin: 'trend',
      kind,
      title: kind === 'hot' ? 'Trend hot content' : 'Trend quality content',
      summary: 'Chinese summary',
      reason: 'Supported by substantive source material',
      sourceUrls: [sourceUrl],
      publishedAt: timestamps.publishedAt ?? null,
      discoveredAt: timestamps.discoveredAt ?? this.now().toISOString(),
      sourceType: 'web',
      platform: 'Web',
      authorName: null,
      authorHandle: null,
      externalId: null,
      provenanceKind: 'ai_citation',
      contentKey: canonicalizeUrl(sourceUrl),
      feedback: null,
      origins: [{ origin: 'trend' }],
    });
    this.radarItems.push({ ...item, userId });
    return structuredClone(item);
  }

  seedCreatorItem(
    userId: string,
    creatorId: string,
    kind: DiscoveryKind,
    timestamps: { publishedAt?: string | null; discoveredAt?: string; sourceUrl?: string } = {},
  ): CreatorItem {
    const creator = this.creators.find((candidate) => (
      candidate.id === creatorId && candidate.userId === userId && candidate.cancelledAt === null
    ));
    if (!creator) throw new Error('Creator was not found');
    const id = randomUUID();
    const item = creatorItemSchema.parse({
      id,
      creatorId,
      kind,
      title: kind === 'hot' ? '博主热点内容' : '博主优质内容',
      summary: '中文摘要',
      reason: '内容深入且有原文依据',
      sourceUrls: [timestamps.sourceUrl ?? `https://example.com/creator/${id}`],
      publishedAt: timestamps.publishedAt ?? null,
      discoveredAt: timestamps.discoveredAt ?? this.now().toISOString(),
      sourceType: 'feed',
      platform: 'RSS/Atom',
      authorName: creator.displayName,
      authorHandle: null,
      externalId: id,
      provenanceKind: 'feed_entry',
      feedEligible: true,
      contentType: 'original',
      originalAuthorName: null,
      originalAuthorHandle: null,
      originalContentId: null,
      originalContentUrl: null,
      parentContentId: null,
      parentContentUrl: null,
      parentContentText: null,
    });
    this.creatorItems.push({ ...item, userId, creatorName: creator.displayName });
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
          topicKeyword: topic.keyword,
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
          contentKey: primary,
          feedback: null,
          origins: [{ origin: 'trend' }],
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

  async healthCheck(): Promise<void> {}
}

function publicRecommendation(
  ranked: PersonalizedSlate['ranked'][number],
  decisionId: string,
): FeedRecommendation {
  const reason = ranked.isExploration
    ? 'exploration'
    : ranked.reasonCodes.includes('FOLLOWED_TOPIC')
      ? 'followed_topic'
      : ranked.reasonCodes.includes('FOLLOWED_CREATOR')
        ? 'followed_creator'
        : ranked.reasonCodes.includes('RELATED_INTEREST')
          ? 'related_interest'
          : 'recent_hot';
  return {
    lane: ranked.lane,
    reason,
    isExploration: ranked.isExploration,
    decisionId,
  };
}

type CreatorWithRuns = PrismaCreatorSubscription & { runs?: PrismaCreatorRun[] };

function mapCreator(creator: CreatorWithRuns): Creator {
  const error = safeErrorSchema.safeParse(creator.lastError);
  const degradedSources = Array.isArray(creator.degradedSources)
    ? creator.degradedSources.flatMap((source) => {
      const parsed = creatorDegradedSourceSchema.safeParse(source);
      return parsed.success ? [parsed.data] : [];
    })
    : [];
  return creatorSchema.parse({
    id: creator.id,
    userId: creator.userId,
    platform: creator.platform,
    displayName: creator.displayName,
    profileUrl: creator.profileUrl,
    feedUrl: creator.feedUrl,
    createdAt: creator.createdAt.toISOString(),
    pausedAt: creator.pausedAt?.toISOString() ?? null,
    lastRunAt: creator.lastRunAt?.toISOString() ?? null,
    nextRunAt: creator.nextRunAt?.toISOString() ?? null,
    runStatus: creator.runStatus,
    lastError: error.success ? error.data : null,
    degradedSources,
    lastRun: mapRunSummary(creator.runs?.[0]),
  });
}

function mapCreatorItem(item: PrismaCreatorItem): CreatorItem {
  return creatorItemSchema.parse({
    id: item.id,
    creatorId: item.creatorId,
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
    feedEligible: item.feedEligible,
    contentType: item.contentType,
    originalAuthorName: item.originalAuthorName,
    originalAuthorHandle: item.originalAuthorHandle,
    originalContentId: item.originalContentId,
    originalContentUrl: item.originalContentUrl,
    parentContentId: item.parentContentId,
    parentContentUrl: item.parentContentUrl,
    parentContentText: item.parentContentText,
  });
}

function mapCreatorFeedItem(
  item: PrismaCreatorItem & { creator: { displayName: string } },
): CreatorFeedItem {
  const creatorItem = mapCreatorItem(item);
  const {
    contentType,
    originalAuthorName: _originalAuthorName,
    originalAuthorHandle: _originalAuthorHandle,
    originalContentId: _originalContentId,
    originalContentUrl: _originalContentUrl,
    parentContentId: _parentContentId,
    parentContentUrl: _parentContentUrl,
    parentContentText: _parentContentText,
    ...feedItem
  } = creatorItem;
  return creatorFeedItemSchema.parse({
    ...feedItem,
    topicId: null,
    origin: 'creator',
    creatorName: item.creator.displayName,
    feedEligible: true,
    contentKey: item.canonicalPrimaryUrl,
    feedback: null,
    origins: [{
      origin: 'creator',
      creatorId: item.creatorId,
      creatorName: item.creator.displayName,
      platform: item.platform,
      contentType,
    }],
  });
}
