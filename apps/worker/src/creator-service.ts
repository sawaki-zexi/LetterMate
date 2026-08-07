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
import { RssConnector } from './connectors/rss.js';
import type { ConnectorResult, SourceQueryPlan } from './connectors/types.js';
import { XCreatorConnector } from './connectors/x-creator.js';
import { BilibiliCreatorConnector } from './connectors/bilibili-creator.js';
import { QualityPipeline } from './quality-pipeline.js';
import { buildKeywordPolicy } from './keyword-policy.js';
import { ContentFetcher } from './content-fetcher.js';
import type { ContentInterestTagger } from './content-interest-tagger.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface CreatorRunClaim {
  state: 'claimed' | 'active' | 'missing';
  runId?: string;
  creator?: Pick<CreatorSubscription, 'id' | 'userId' | 'platform' | 'accountKey' | 'displayName' | 'profileUrl' | 'feedUrl'>;
}

export interface CreatorRepository {
  claimRun(input: CreatorJobData, startedAt: Date): Promise<CreatorRunClaim>;
  listHistoryUrls(creatorId: string): Promise<string[]>;
  saveSuccess(input: {
    runId: string;
    creatorId: string;
    userId: string;
    trigger: DiscoveryTrigger;
    candidates: ValidatedSourceCandidate[];
    items: DiscoveryCandidate[];
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
  createConnector?: (creator: NonNullable<CreatorRunClaim['creator']>) => {
    search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult>;
  };
  twitterApiKey?: string | undefined;
  timeoutMs?: number;
  now?: () => Date;
  interestTagger?: Pick<ContentInterestTagger, 'tagCandidates'>;
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
      if (!creator.feedUrl) throw new Error('RSS creator is missing a feed URL');
      return new RssConnector({ feedUrls: [creator.feedUrl], maxEntriesPerFeed: 30 });
    });
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  async run(job: CreatorJobData, context: { finalAttempt: boolean } = { finalAttempt: true }): Promise<void> {
    const parsed = creatorJobDataSchema.parse(job);
    const claim = await this.options.repository.claimRun(parsed, this.now());
    if (claim.state !== 'claimed' || !claim.creator || !claim.runId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const windowEnd = this.now();
      const windowStart = new Date(windowEnd.getTime() - 7 * DAY_MS);
      const plan: SourceQueryPlan = {
        keyword: claim.creator.displayName,
        expandedTerms: [],
        queries: [claim.creator.displayName],
        sourceTypes: [claim.creator.platform === 'x' ? 'social' : 'feed'],
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        maxCandidates: 30,
        matchPolicy: buildKeywordPolicy(claim.creator.displayName),
      };
      const [result, historyUrls] = await Promise.all([
        this.createConnector(claim.creator).search(plan, controller.signal),
        this.options.repository.listHistoryUrls(claim.creator.id),
      ]);
      if (controller.signal.aborted) throw new Error('Creator run timed out');
      const candidates = result.candidates.map((candidate) => validateSourceCandidate(candidate));
      const items = await this.options.qualityPipeline.run({
        keyword: claim.creator.displayName,
        candidates,
        historyUrls,
        windowStart: plan.windowStart,
        windowEnd: plan.windowEnd,
        signal: controller.signal,
      });
      const finishedAt = this.now();
      await this.options.repository.saveSuccess({
        runId: claim.runId,
        creatorId: claim.creator.id,
        userId: claim.creator.userId,
        trigger: parsed.trigger,
        candidates,
        items,
        ...(result.identity ? { identity: result.identity } : {}),
        finishedAt,
      });
      await this.options.interestTagger?.tagCandidates(items, controller.signal);
    } catch (error) {
      await this.options.repository.saveFailure({
        runId: claim.runId,
        creatorId: claim.creator.id,
        userId: claim.creator.userId,
        error: safeError(error),
        finishedAt: this.now(),
        status: context.finalAttempt ? 'failed' : 'queued',
        trigger: parsed.trigger,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
      const runId = randomUUID();
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
      if (creator.activeRunId) {
        await transaction.creatorRun.updateMany({
          where: { id: creator.activeRunId, status: { in: ['queued', 'running'] } },
          data: { status: 'failed', finishedAt: startedAt, error: { code: 'CREATOR_RUN_LEASE_EXPIRED' } },
        });
      }
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
      return {
        state: 'claimed',
        runId,
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

  async saveSuccess(input: {
    runId: string; creatorId: string; userId: string; trigger: DiscoveryTrigger;
    candidates: ValidatedSourceCandidate[]; items: DiscoveryCandidate[]; finishedAt: Date;
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
      let inserted = 0;
      for (const source of input.candidates) {
        const item = itemByUrl.get(source.canonicalUrl);
        const context = source.creatorContext;
        const summary = (item?.summary ?? source.content ?? source.excerpt ?? source.title ?? '公开内容').slice(0, 1_000);
        const data = {
          userId: input.userId,
          creatorId: input.creatorId,
          kind: item?.kind ?? 'quality' as const,
          title: (item?.title ?? source.title ?? source.excerpt ?? '公开内容').slice(0, 300),
          summary,
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
      await transaction.creatorRun.update({
        where: { id: input.runId },
        data: { status: 'succeeded', finishedAt: input.finishedAt, candidateCount: input.candidates.length, acceptedCount: input.items.length, newItemCount: inserted },
      });
      await transaction.creatorSubscription.update({
        where: { id: input.creatorId },
        data: {
          ...(input.identity ? {
            displayName: input.identity.displayName,
            profileUrl: input.identity.profileUrl,
          } : {}),
          runStatus: 'succeeded',
          activeRunId: null,
          runLeaseUntil: null,
          lastRunAt: input.finishedAt,
          nextRunAt: new Date(input.finishedAt.getTime() + DAY_MS),
          lastError: Prisma.DbNull,
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
        data: { activeRunId: null, runLeaseUntil: null },
      });
      if (ownership.count !== 1) return;
      await transaction.creatorRun.update({
        where: { id: input.runId },
        data: { status: input.status, finishedAt: input.finishedAt, error: input.error },
      });
      await transaction.creatorSubscription.update({
        where: { id: input.creatorId },
        data: {
          runStatus: input.status,
          lastRunAt: input.finishedAt,
          nextRunAt: new Date(input.finishedAt.getTime() + DAY_MS),
          lastError: input.error,
        },
      });
    });
  }
}

export function createCreatorDiscoveryService(
  prisma: PrismaClient,
  gateway: Pick<AiGateway, 'evaluateCandidates' | 'composeItems'>,
  timeoutMs: number,
  twitterApiKey?: string,
  interestTagger?: Pick<ContentInterestTagger, 'tagCandidates'>,
): CreatorDiscoveryService {
  return new CreatorDiscoveryService({
    repository: new PrismaCreatorRepository(prisma),
    qualityPipeline: new QualityPipeline(new ContentFetcher(), gateway),
    timeoutMs,
    twitterApiKey,
    ...(interestTagger ? { interestTagger } : {}),
  });
}
