import {
  creatorJobDataSchema,
  type CreatorJobData,
  type DiscoveryCandidate,
  type DiscoveryTrigger,
  type SafeError,
} from '@lettermate/contracts';
import { canonicalizeUrl, validateSourceCandidate, type ValidatedSourceCandidate } from '@lettermate/domain';
import { Prisma, type CreatorSubscription, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AiGateway } from './ai-gateway.js';
import type {
  CreatorArchiveLocalization,
  CreatorArchiveLocalizationCandidate,
} from './ai-gateway.js';
import { RssConnector } from './connectors/rss.js';
import type { ConnectorDegradation, ConnectorResult, SourceQueryPlan } from './connectors/types.js';
import { XCreatorConnector } from './connectors/x-creator.js';
import { BilibiliCreatorConnector } from './connectors/bilibili-creator.js';
import { YouTubeCreatorConnector } from './connectors/youtube-creator.js';
import { BlueskyCreatorConnector } from './connectors/bluesky-creator.js';
import { QualityPipeline } from './quality-pipeline.js';
import { buildKeywordPolicy } from './keyword-policy.js';
import { ContentFetcher } from './content-fetcher.js';
import type { ContentInterestTagger } from './content-interest-tagger.js';
import type { AiExecutionContext } from './ai-runtime.js';
import type { RunStageManager } from './run-stage.js';
import { isChineseContent } from './chinese-content.js';
import {
  recordSourceAttemptSafely,
  type SourceFunnelSink,
} from './source-observability.js';
import { isExplicitlyNonRetryable } from './retry-policy.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const ARCHIVE_LOCALIZATION_BATCH_SIZE = 8;
const ARCHIVE_LOCALIZATION_BACKFILL_LIMIT = 30;
const CREATOR_PARTIAL_SYNC_ERROR: SafeError = {
  code: 'CREATOR_PARTIAL_SYNC',
  message: '部分来源暂时不可用，已保留可用内容',
};

const creatorSourceIdentity = (platform: CreatorSubscription['platform']) => {
  if (platform === 'x') {
    return { source: 'twitterapi-io-x-creator', sourceType: 'social' as const };
  }
  if (platform === 'bilibili') {
    return { source: 'bilibili-creator', sourceType: 'feed' as const };
  }
  if (platform === 'youtube') {
    return { source: 'youtube-creator', sourceType: 'video' as const };
  }
  if (platform === 'bluesky') {
    return { source: 'bluesky-creator', sourceType: 'social' as const };
  }
  return { source: 'rss', sourceType: 'feed' as const };
};

export interface CreatorRunClaim {
  state: 'claimed' | 'active' | 'missing';
  runId?: string;
  startedAt?: Date;
  creator?: Pick<CreatorSubscription, 'id' | 'userId' | 'platform' | 'accountKey' | 'displayName' | 'profileUrl' | 'feedUrl'>;
}

export interface CreatorRepository {
  claimRun(input: CreatorJobData, startedAt: Date): Promise<CreatorRunClaim>;
  listHistoryUrls(creatorId: string): Promise<string[]>;
  listArchiveItemsNeedingLocalization(
    creatorId: string,
    limit: number,
  ): Promise<CreatorArchiveLocalizationCandidate[]>;
  saveSuccess(input: {
    runId: string;
    creatorId: string;
    userId: string;
    trigger: DiscoveryTrigger;
    candidates: ValidatedSourceCandidate[];
    items: DiscoveryCandidate[];
    archiveLocalizations: CreatorArchiveLocalization[];
    degradations?: ConnectorDegradation[];
    identity?: { displayName: string; profileUrl: string; handle: string | null };
    finishedAt: Date;
  }): Promise<number>;
  saveFailure(input: {
    runId: string;
    creatorId: string;
    userId: string;
    error: SafeError;
    finishedAt: Date;
    status: 'queued' | 'failed';
    trigger: DiscoveryTrigger;
  }): Promise<void>;
}

function safeError(error: unknown): SafeError {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return { code, message: '博主内容同步暂时不可用' };
  }
  return { code: 'CREATOR_RUN_FAILED', message: '博主内容同步暂时不可用' };
}

export interface CreatorDiscoveryServiceOptions {
  repository: CreatorRepository;
  qualityPipeline: Pick<QualityPipeline, 'run'>;
  archiveLocalizer: Pick<AiGateway, 'localizeCreatorItems'>;
  createConnector?: (creator: NonNullable<CreatorRunClaim['creator']>) => {
    search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult>;
  };
  twitterApiKey?: string | undefined;
  youtubeApiKey?: string | undefined;
  timeoutMs?: number;
  now?: () => Date;
  interestTagger?: Pick<ContentInterestTagger, 'tagCandidates'>;
  stageManager?: RunStageManager;
  sourceTelemetry?: SourceFunnelSink;
}

export class CreatorDiscoveryService {
  private readonly createConnector: NonNullable<CreatorDiscoveryServiceOptions['createConnector']>;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: CreatorDiscoveryServiceOptions) {
    this.createConnector = options.createConnector ?? ((creator) => {
      if (creator.platform === 'x') {
        return new XCreatorConnector({ apiKey: options.twitterApiKey, userId: creator.accountKey });
      }
      if (creator.platform === 'bilibili') {
        return new BilibiliCreatorConnector({ mid: creator.accountKey });
      }
      if (creator.platform === 'youtube') {
        return new YouTubeCreatorConnector({ apiKey: options.youtubeApiKey, channelId: creator.accountKey });
      }
      if (creator.platform === 'bluesky') {
        return new BlueskyCreatorConnector({ did: creator.accountKey });
      }
      if (!creator.feedUrl) throw new Error('RSS creator is missing a feed URL');
      return new RssConnector({ feedUrls: [creator.feedUrl], maxEntriesPerFeed: 30 });
    });
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  async run(job: CreatorJobData, context: { finalAttempt: boolean } = { finalAttempt: true }): Promise<void> {
    const parsed = creatorJobDataSchema.parse(job);
    const startedAt = this.now();
    const claim = await this.options.repository.claimRun(parsed, startedAt);
    if (claim.state !== 'claimed' || !claim.creator || !claim.runId) return;
    const creator = claim.creator;
    const execution: AiExecutionContext = {
      runId: claim.runId, userId: claim.creator.userId, runKind: 'creator',
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const windowEnd = claim.startedAt ?? startedAt;
      const windowStart = new Date(windowEnd.getTime() - 7 * DAY_MS);
      const plan: SourceQueryPlan = {
        keyword: claim.creator.displayName,
        expandedTerms: [],
        queries: [claim.creator.displayName],
        sourceTypes: [claim.creator.platform === 'x' || claim.creator.platform === 'bluesky'
          ? 'social'
          : claim.creator.platform === 'youtube' ? 'video' : 'feed'],
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        maxCandidates: 30,
        matchPolicy: buildKeywordPolicy(claim.creator.displayName),
      };
      const sourceIdentity = creatorSourceIdentity(creator.platform);
      let connector: ReturnType<NonNullable<CreatorDiscoveryServiceOptions['createConnector']>>;
      try {
        connector = this.createConnector(creator);
      } catch (error) {
        recordSourceAttemptSafely(this.options.sourceTelemetry, {
          ...sourceIdentity,
          result: 'failure',
          code: 'CREATOR_CONNECTOR_FAILED',
        });
        throw error;
      }
      const retrieval = this.runStage(
        execution, 'retrieve', { creatorId: creator.id, plan },
        () => connector.search(plan, controller.signal),
      ).then((result) => {
        const candidates = result.candidates.map((candidate) => validateSourceCandidate(candidate));
        recordSourceAttemptSafely(this.options.sourceTelemetry, {
          ...sourceIdentity,
          result: 'success',
        });
        return { result, candidates };
      }).catch((error: unknown) => {
        recordSourceAttemptSafely(this.options.sourceTelemetry, {
          ...sourceIdentity,
          result: 'failure',
          code: 'CREATOR_CONNECTOR_FAILED',
        });
        throw error;
      });
      const [{ result, candidates }, historyUrls, archiveBackfill] = await Promise.all([
        retrieval,
        this.options.repository.listHistoryUrls(claim.creator.id),
        this.options.repository.listArchiveItemsNeedingLocalization(
          claim.creator.id,
          ARCHIVE_LOCALIZATION_BACKFILL_LIMIT,
        ),
      ]);
      if (controller.signal.aborted) throw new Error('Creator run timed out');
      const items = await this.runStage(
        execution, 'quality_gate', { keyword: creator.displayName, plan, candidates, historyUrls },
        () => this.options.qualityPipeline.run({
          keyword: creator.displayName,
          candidates,
          historyUrls,
          windowStart: plan.windowStart,
          windowEnd: plan.windowEnd,
          execution,
          signal: controller.signal,
        }),
      );
      const feedUrls = new Set(items.flatMap((item) => (
        item.sourceUrls.map((url) => canonicalizeUrl(url))
      )));
      const historyUrlSet = new Set(historyUrls);
      const newArchiveCandidates = candidates.flatMap((candidate) => {
        if (feedUrls.has(candidate.canonicalUrl) || historyUrlSet.has(candidate.canonicalUrl)) return [];
        const text = candidate.content ?? candidate.excerpt ?? candidate.title;
        if (!text) return [];
        return [{
          id: candidate.canonicalUrl,
          title: candidate.title,
          text,
          platform: candidate.platform,
          authorName: candidate.authorName,
          authorHandle: candidate.authorHandle,
          publishedAt: candidate.publishedAt,
        }];
      });
      const archiveCandidatesById = new Map(
        [...archiveBackfill, ...newArchiveCandidates].map((candidate) => [candidate.id, candidate]),
      );
      const archiveLocalizations = await this.localizeArchiveItems(
        claim.creator.displayName,
        [...archiveCandidatesById.values()],
        controller.signal,
        execution,
      );
      const finishedAt = this.now();
      await this.options.repository.saveSuccess({
        runId: claim.runId,
        creatorId: claim.creator.id,
        userId: claim.creator.userId,
        trigger: parsed.trigger,
        candidates,
        items,
        archiveLocalizations,
        ...(result.degradations ? { degradations: result.degradations } : {}),
        ...(result.identity ? { identity: result.identity } : {}),
        finishedAt,
      });
      await this.options.interestTagger?.tagCandidates(items, controller.signal, execution);
    } catch (error) {
      const terminalFailure = context.finalAttempt || isExplicitlyNonRetryable(error);
      await this.options.repository.saveFailure({
        runId: claim.runId,
        creatorId: claim.creator.id,
        userId: claim.creator.userId,
        error: safeError(error),
        finishedAt: this.now(),
        status: terminalFailure ? 'failed' : 'queued',
        trigger: parsed.trigger,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async localizeArchiveItems(
    creatorName: string,
    candidates: CreatorArchiveLocalizationCandidate[],
    signal: AbortSignal,
    execution: AiExecutionContext,
  ): Promise<CreatorArchiveLocalization[]> {
    const results: CreatorArchiveLocalization[] = [];
    for (let index = 0; index < candidates.length; index += ARCHIVE_LOCALIZATION_BATCH_SIZE) {
      const batch = candidates.slice(index, index + ARCHIVE_LOCALIZATION_BATCH_SIZE);
      results.push(...await this.localizeArchiveBatch(creatorName, batch, signal, execution));
    }
    return results;
  }

  private async localizeArchiveBatch(
    creatorName: string,
    candidates: CreatorArchiveLocalizationCandidate[],
    signal: AbortSignal,
    execution: AiExecutionContext,
  ): Promise<CreatorArchiveLocalization[]> {
    if (candidates.length === 0) return [];
    try {
      const items = await this.runStage(
        execution, 'compose', { creatorName, candidates },
        () => this.options.archiveLocalizer.localizeCreatorItems({
          creatorName, candidates, execution, signal,
        }),
      );
      const inputIds = new Set(candidates.map(({ id }) => id));
      const outputIds = new Set<string>();
      for (const item of items) {
        if (
          !inputIds.has(item.id)
          || outputIds.has(item.id)
          || !isChineseContent(item.title)
          || !isChineseContent(item.summary)
        ) {
          throw new Error('Creator archive localization returned invalid items');
        }
        outputIds.add(item.id);
      }
      if (outputIds.size !== inputIds.size) {
        throw new Error('Creator archive localization returned incomplete items');
      }
      return items;
    } catch (error) {
      if (signal.aborted) throw error;
      if (candidates.length === 1) return [];
      const midpoint = Math.ceil(candidates.length / 2);
      const left = await this.localizeArchiveBatch(
        creatorName, candidates.slice(0, midpoint), signal, execution,
      );
      const right = await this.localizeArchiveBatch(
        creatorName, candidates.slice(midpoint), signal, execution,
      );
      return [...left, ...right];
    }
  }

  private runStage<T>(
    execution: AiExecutionContext,
    stage: 'retrieve' | 'quality_gate' | 'compose',
    value: unknown,
    execute: () => Promise<T>,
  ): Promise<T> {
    return this.options.stageManager
      ? this.options.stageManager.run({ execution, stage, value, execute })
      : execute();
  }
}

export class PrismaCreatorRepository implements CreatorRepository {
  constructor(private readonly prisma: PrismaClient, private readonly runLeaseMs = 20 * 60_000) {}

  async claimRun(input: CreatorJobData, startedAt: Date): Promise<CreatorRunClaim> {
    return this.prisma.$transaction(async (transaction) => {
      const creator = await transaction.creatorSubscription.findFirst({
        where: { id: input.creatorId, userId: input.userId, cancelledAt: null },
      });
      if (!creator) return { state: 'missing' };
      if (creator.pausedAt) return { state: 'active' };
      if (creator.runStatus === 'running' && creator.runLeaseUntil && creator.runLeaseUntil > startedAt) {
        return { state: 'active' };
      }
      const resumedRunId = creator.runStatus === 'queued' ? creator.activeRunId : null;
      const runId = resumedRunId ?? randomUUID();
      const claimed = await transaction.creatorSubscription.updateMany({
        where: {
          id: creator.id,
          userId: input.userId,
          cancelledAt: null,
          pausedAt: null,
          activeRunId: creator.activeRunId,
          OR: [
            { runStatus: { not: 'running' } },
            { runLeaseUntil: null },
            { runLeaseUntil: { lte: startedAt } },
          ],
        },
        data: {
          runStatus: 'running',
          activeRunId: runId,
          runLeaseUntil: new Date(startedAt.getTime() + this.runLeaseMs),
          lastError: Prisma.DbNull,
        },
      });
      if (claimed.count !== 1) return { state: 'active' };
      if (resumedRunId === null && creator.activeRunId) {
        await transaction.creatorRun.updateMany({
          where: { id: creator.activeRunId, status: { in: ['queued', 'running'] } },
          data: { status: 'failed', finishedAt: startedAt, error: { code: 'CREATOR_RUN_LEASE_EXPIRED' } },
        });
      }
      let runStartedAt = startedAt;
      if (resumedRunId) {
        const run = await transaction.creatorRun.update({
          where: { id: resumedRunId },
          data: { status: 'running', finishedAt: null, error: Prisma.DbNull },
          select: { startedAt: true },
        });
        runStartedAt = run.startedAt;
      } else {
        await transaction.creatorRun.create({
          data: {
            id: runId,
            userId: input.userId,
            creatorId: creator.id,
            trigger: input.trigger,
            status: 'running',
            startedAt,
          },
        });
      }
      return {
        state: 'claimed',
        runId,
        startedAt: runStartedAt,
        creator: {
          id: creator.id,
          userId: creator.userId,
          displayName: creator.displayName,
          platform: creator.platform,
          accountKey: creator.accountKey,
          profileUrl: creator.profileUrl,
          feedUrl: creator.feedUrl,
        },
      };
    });
  }

  async listHistoryUrls(creatorId: string): Promise<string[]> {
    const items = await this.prisma.creatorItem.findMany({ where: { creatorId }, select: { sourceUrls: true } });
    return [...new Set(items.flatMap((item) => item.sourceUrls.map((url) => canonicalizeUrl(url))))];
  }

  async listArchiveItemsNeedingLocalization(
    creatorId: string,
    limit: number,
  ): Promise<CreatorArchiveLocalizationCandidate[]> {
    if (limit <= 0) return [];
    const results: CreatorArchiveLocalizationCandidate[] = [];
    let cursor: string | undefined;
    const pageSize = 100;
    while (results.length < limit) {
      const rows = await this.prisma.creatorItem.findMany({
        where: { creatorId },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          canonicalPrimaryUrl: true,
          title: true,
          summary: true,
          platform: true,
          authorName: true,
          authorHandle: true,
          publishedAt: true,
        },
      });
      for (const row of rows) {
        if (isChineseContent(row.title) && isChineseContent(row.summary)) continue;
        results.push({
          id: row.canonicalPrimaryUrl,
          title: row.title,
          text: row.summary,
          platform: row.platform,
          authorName: row.authorName,
          authorHandle: row.authorHandle,
          publishedAt: row.publishedAt?.toISOString() ?? null,
        });
        if (results.length === limit) break;
      }
      if (rows.length < pageSize) break;
      cursor = rows.at(-1)?.id;
      if (!cursor) break;
    }
    return results;
  }

  async saveSuccess(input: {
    runId: string; creatorId: string; userId: string; trigger: DiscoveryTrigger;
    candidates: ValidatedSourceCandidate[]; items: DiscoveryCandidate[];
    archiveLocalizations: CreatorArchiveLocalization[]; finishedAt: Date;
    degradations?: ConnectorDegradation[];
    identity?: { displayName: string; profileUrl: string; handle: string | null };
  }): Promise<number> {
    return this.prisma.$transaction(async (transaction) => {
      const creator = await transaction.creatorSubscription.findFirst({
        where: { id: input.creatorId, userId: input.userId, activeRunId: input.runId, cancelledAt: null },
      });
      if (!creator) return 0;
      const itemByUrl = new Map(input.items.flatMap((item) => item.sourceUrls.map((url) => [canonicalizeUrl(url), item] as const)));
      const existing = new Set((await transaction.creatorItem.findMany({
        where: { creatorId: input.creatorId },
        select: { canonicalPrimaryUrl: true },
      })).map((item) => item.canonicalPrimaryUrl));
      const localizationByUrl = new Map(input.archiveLocalizations.map((item) => (
        [canonicalizeUrl(item.id), item] as const
      )));
      for (const [canonicalUrl, localization] of localizationByUrl) {
        if (!existing.has(canonicalUrl)) continue;
        await transaction.creatorItem.updateMany({
          where: { creatorId: input.creatorId, canonicalPrimaryUrl: canonicalUrl },
          data: { title: localization.title.slice(0, 300), summary: localization.summary.slice(0, 1_000) },
        });
      }
      let inserted = 0;
      for (const source of input.candidates) {
        const item = itemByUrl.get(source.canonicalUrl);
        if (!item && existing.has(source.canonicalUrl)) continue;
        const localization = localizationByUrl.get(source.canonicalUrl);
        if (!item && !localization) continue;
        const context = source.creatorContext;
        const data = {
          userId: input.userId,
          creatorId: input.creatorId,
          kind: item?.kind ?? 'quality' as const,
          title: (item?.title ?? localization!.title).slice(0, 300),
          summary: (item?.summary ?? localization!.summary).slice(0, 1_000),
          reason: item?.reason ?? '未进入本次精选',
          sourceUrls: item?.sourceUrls ?? [source.canonicalUrl],
          canonicalPrimaryUrl: source.canonicalUrl,
          publishedAt: item?.publishedAt
            ? new Date(item.publishedAt)
            : source.publishedAt ? new Date(source.publishedAt) : null,
          sourceType: item?.sourceType ?? source.sourceType,
          platform: item?.platform ?? source.platform,
          authorName: item?.authorName ?? source.authorName,
          authorHandle: item?.authorHandle ?? source.authorHandle,
          externalId: item?.externalId ?? source.externalId,
          provenanceKind: item?.provenanceKind ?? source.proof.kind,
          feedEligible: Boolean(item),
          contentType: context?.contentType ?? 'original' as const,
          originalAuthorName: context?.originalAuthorName ?? null,
          originalAuthorHandle: context?.originalAuthorHandle ?? null,
          originalContentId: context?.originalContentId ?? null,
          originalContentUrl: context?.originalContentUrl ?? null,
          parentContentId: context?.parentContentId ?? null,
          parentContentUrl: context?.parentContentUrl ?? null,
          parentContentText: context?.parentContentText ?? null,
        };
        const { userId: _userId, creatorId: _creatorId, ...updateData } = data;
        await transaction.creatorItem.upsert({
          where: { creatorId_canonicalPrimaryUrl: { creatorId: input.creatorId, canonicalPrimaryUrl: source.canonicalUrl } },
          create: data,
          update: updateData,
        });
        if (!existing.has(source.canonicalUrl)) inserted += 1;
      }
      const degraded = (input.degradations?.length ?? 0) > 0;
      const finalStatus = degraded ? 'degraded' : 'succeeded';
      const safePartialError = degraded ? CREATOR_PARTIAL_SYNC_ERROR : null;
      const degradedSources = input.degradations?.length
        ? input.degradations.map((source) => ({ ...source })) as Prisma.InputJsonValue
        : Prisma.DbNull;
      await transaction.creatorRun.update({
        where: { id: input.runId },
        data: {
          status: finalStatus,
          finishedAt: input.finishedAt,
          candidateCount: input.candidates.length,
          acceptedCount: input.items.length,
          newItemCount: inserted,
          degradedSources,
          error: safePartialError ?? Prisma.DbNull,
        },
      });
      await transaction.creatorSubscription.update({
        where: { id: input.creatorId },
        data: {
          ...(input.identity ? {
            displayName: input.identity.displayName,
            profileUrl: input.identity.profileUrl,
          } : {}),
          runStatus: finalStatus,
          activeRunId: null,
          runLeaseUntil: null,
          lastRunAt: input.finishedAt,
          nextRunAt: new Date(input.finishedAt.getTime() + DAY_MS),
          lastError: safePartialError ?? Prisma.DbNull,
          degradedSources,
        },
      });
      return inserted;
    });
  }

  async saveFailure(input: {
    runId: string; creatorId: string; userId: string; error: SafeError; finishedAt: Date;
    status: 'queued' | 'failed'; trigger: DiscoveryTrigger;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const ownership = await transaction.creatorSubscription.updateMany({
        where: { id: input.creatorId, userId: input.userId, activeRunId: input.runId, cancelledAt: null },
        data: {
          activeRunId: input.status === 'queued' ? input.runId : null,
          runLeaseUntil: input.status === 'queued' ? input.finishedAt : null,
        },
      });
      if (ownership.count !== 1) return;
      await transaction.creatorRun.update({
        where: { id: input.runId },
        data: {
          status: input.status,
          finishedAt: input.finishedAt,
          error: input.error,
          degradedSources: Prisma.DbNull,
        },
      });
      await transaction.creatorSubscription.update({
        where: { id: input.creatorId },
        data: {
          runStatus: input.status,
          lastRunAt: input.finishedAt,
          nextRunAt: new Date(input.finishedAt.getTime() + DAY_MS),
          lastError: input.error,
          degradedSources: Prisma.DbNull,
        },
      });
    });
  }
}

export function createCreatorDiscoveryService(
  prisma: PrismaClient,
  gateway: Pick<AiGateway, 'evaluateCandidates' | 'composeItems' | 'localizeCreatorItems'>,
  timeoutMs: number,
  twitterApiKey?: string,
  youtubeApiKey?: string,
  interestTagger?: Pick<ContentInterestTagger, 'tagCandidates'>,
  stageManager?: RunStageManager,
  sourceTelemetry?: SourceFunnelSink,
): CreatorDiscoveryService {
  return new CreatorDiscoveryService({
    repository: new PrismaCreatorRepository(prisma),
    qualityPipeline: new QualityPipeline(new ContentFetcher(), gateway, sourceTelemetry),
    archiveLocalizer: gateway,
    timeoutMs,
    twitterApiKey,
    youtubeApiKey,
    ...(interestTagger ? { interestTagger } : {}),
    ...(stageManager ? { stageManager } : {}),
    ...(sourceTelemetry ? { sourceTelemetry } : {}),
  });
}
