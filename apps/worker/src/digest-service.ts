import { randomUUID } from 'node:crypto';
import type { DigestJobData, FeedItem } from '@lettermate/contracts';
import {
  INTEREST_ADJACENCY_VERSION,
  INTEREST_EXTRACTOR_VERSION,
  applyExplorationEligibility,
  canonicalizeUrl,
  mergeFeedItems,
  rankShadowSlate,
  type CandidateInterestTag,
  type InterestProfileEntry,
  type InterestTagAdjacency,
} from '@lettermate/domain';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { EmailGateway } from './digest-email.js';
import { EmailGatewayError, renderDigestEmail } from './digest-email.js';
import { DigestBriefGenerator } from './digest-brief-generator.js';

const MAX_DIGEST_ITEMS = 10;
const DEFAULT_WINDOW_START = new Date(0);
const DIGEST_UNCERTAINTY = '邮件摘要仅基于已验证的原始来源，不替代对完整原文的独立核验。';
const DIGEST_FOLLOW_UP = '打开原文核验关键细节，并继续关注后续更新或独立来源。';

export interface DigestSnapshot {
  contentKey: string;
  position: number;
  title: string;
  summary: string;
  reason: string;
  sourceUrl: string;
  citationUrls: string[];
  platform: string;
  publishedAt: Date | null;
  evidence: string;
  uncertainty: string;
  followUp: string;
}

export interface DigestCandidateTag extends CandidateInterestTag {
  contentKey: string;
}

const isHttpUrl = (value: string): boolean => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export function selectDigestSnapshots(input: {
  candidates: readonly FeedItem[];
  profiles: readonly InterestProfileEntry[];
  tags: readonly DigestCandidateTag[];
  adjacencies: readonly InterestTagAdjacency[];
  forgottenTagIds: readonly string[];
  deliveredContentKeys: ReadonlySet<string>;
  asOf: Date;
}): DigestSnapshot[] {
  const deliveredContentKeys = new Set(
    [...input.deliveredContentKeys].map(canonicalizeUrl),
  );
  const candidates = mergeFeedItems(input.candidates)
    .filter((item) => ![item.contentKey, ...item.sourceUrls].some((url) => (
      isHttpUrl(url) && deliveredContentKeys.has(canonicalizeUrl(url))
    )))
    .filter((item) => isHttpUrl(item.contentKey));
  const tagsByContent = new Map<string, CandidateInterestTag[]>();
  for (const tag of input.tags) {
    const values = tagsByContent.get(tag.contentKey) ?? [];
    values.push({ tagId: tag.tagId, confidence: tag.confidence });
    tagsByContent.set(tag.contentKey, values);
  }
  const digestCandidates = applyExplorationEligibility({
    candidates: candidates.map((item) => ({
      item,
      tags: tagsByContent.get(item.contentKey) ?? [],
    })),
    profile: input.profiles,
    adjacencies: input.adjacencies,
    forgottenTagIds: input.forgottenTagIds,
    surface: 'feed',
  }).filter((candidate) => !candidate.explorationEligible);
  const ranked = rankShadowSlate({
    candidates: digestCandidates,
    profile: input.profiles,
    asOf: input.asOf,
  });
  const candidateByKey = new Map(candidates.map((item) => [item.contentKey, item]));
  return ranked.slice(0, MAX_DIGEST_ITEMS).flatMap((entry, position) => {
    const item = candidateByKey.get(entry.contentKey);
    const citationUrls = [...new Set(item?.sourceUrls.filter(isHttpUrl) ?? [])];
    const sourceUrl = citationUrls[0];
    return item && sourceUrl ? [{
      contentKey: item.contentKey,
      position,
      title: item.title,
      summary: item.summary,
      reason: item.reason,
      sourceUrl,
      citationUrls,
      platform: item.platform,
      publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
      evidence: item.reason,
      uncertainty: DIGEST_UNCERTAINTY,
      followUp: DIGEST_FOLLOW_UP,
    }] : [];
  });
}

const timeWhere = (windowStart: Date, windowEnd: Date) => ({
  OR: [
    { publishedAt: { gt: windowStart, lte: windowEnd } },
    { publishedAt: null, discoveredAt: { gt: windowStart, lte: windowEnd } },
  ],
});

const commonFeedFields = <T extends {
  id: string;
  kind: 'hot' | 'quality';
  title: string;
  summary: string;
  reason: string;
  sourceUrls: string[];
  canonicalPrimaryUrl: string;
  publishedAt: Date | null;
  discoveredAt: Date;
  sourceType: FeedItem['sourceType'];
  platform: string;
  authorName: string | null;
  authorHandle: string | null;
  externalId: string | null;
  provenanceKind: FeedItem['provenanceKind'];
}>(item: T) => ({
  id: item.id,
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
});

async function loadDigestSnapshots(
  transaction: Prisma.TransactionClient,
  userId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<DigestSnapshot[]> {
  const where = timeWhere(windowStart, windowEnd);
  const [topicRows, trendRows, creatorRows, deliveredRows, settings, profiles, forgotten] =
    await Promise.all([
      transaction.discoveryItem.findMany({
        where: { ...where, topic: { userId } },
        include: { topic: { select: { deletedAt: true, keyword: true } } },
        orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
        take: 500,
      }),
      transaction.radarItem.findMany({
        where: { userId, ...where },
        orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
        take: 500,
      }),
      transaction.creatorItem.findMany({
        where: { userId, feedEligible: true, creator: { cancelledAt: null }, ...where },
        include: { creator: { select: { displayName: true } } },
        orderBy: [{ publishedAt: 'desc' }, { discoveredAt: 'desc' }, { id: 'desc' }],
        take: 500,
      }),
      transaction.digestItem.findMany({
        where: { run: { userId, status: 'succeeded' } },
        select: { contentKey: true },
      }),
      transaction.interestMemorySettings.findUnique({
        where: { userId }, select: { personalizationEnabled: true },
      }),
      transaction.userInterestProfile.findMany({
        where: { userId },
        select: {
          tagId: true, shortScore: true, longScore: true, negativeScore: true,
          evidenceUpdatedAt: true, sourceKinds: true,
        },
      }),
      transaction.forgottenInterestTag.findMany({
        where: { userId }, select: { tagId: true },
      }),
    ]);
  const candidates: FeedItem[] = [
    ...topicRows.map((item): FeedItem => {
      const active = item.topic.deletedAt === null && item.topic.keyword === item.topicKeyword;
      return {
        ...commonFeedFields(item),
        topicId: item.topicId,
        origin: 'topic',
        topicKeyword: item.topicKeyword,
        topicKeywordActive: active,
        origins: [{
          origin: 'topic', topicId: item.topicId,
          topicKeyword: item.topicKeyword, topicKeywordActive: active,
        }],
      };
    }),
    ...trendRows.map((item): FeedItem => ({
      ...commonFeedFields(item),
      topicId: null,
      origin: 'trend',
      origins: [{ origin: 'trend' }],
    })),
    ...creatorRows.map((item): FeedItem => ({
      ...commonFeedFields(item),
      topicId: null,
      origin: 'creator',
      creatorId: item.creatorId,
      creatorName: item.creator.displayName,
      feedEligible: true,
      origins: [{
        origin: 'creator', creatorId: item.creatorId,
        creatorName: item.creator.displayName, platform: item.platform,
        contentType: item.contentType,
      }],
    })),
  ];
  const mergedKeys = [...new Set(candidates.map((item) => item.contentKey))];
  const tagRows = mergedKeys.length === 0 ? [] : await transaction.contentInterestTag.findMany({
    where: { contentKey: { in: mergedKeys }, extractorVersion: INTEREST_EXTRACTOR_VERSION },
    select: { contentKey: true, tagId: true, confidence: true },
  });
  const forgottenIds = new Set(forgotten.map((entry) => entry.tagId));
  const activeProfiles = settings?.personalizationEnabled === false ? [] : profiles
    .filter((profile) => !forgottenIds.has(profile.tagId));
  const profileTagIds = [...new Set(activeProfiles.map((profile) => profile.tagId))];
  const candidateTagIds = [...new Set(tagRows.map((tag) => tag.tagId))];
  const adjacencyRows = profileTagIds.length === 0 || candidateTagIds.length === 0
    ? []
    : await transaction.interestTagAdjacency.findMany({
        where: {
          relationVersion: INTEREST_ADJACENCY_VERSION,
          OR: [
            { leftTagId: { in: profileTagIds }, rightTagId: { in: candidateTagIds } },
            { rightTagId: { in: profileTagIds }, leftTagId: { in: candidateTagIds } },
          ],
        },
        select: { leftTagId: true, rightTagId: true },
      });
  return selectDigestSnapshots({
    candidates,
    deliveredContentKeys: new Set(deliveredRows.map((row) => row.contentKey)),
    profiles: activeProfiles
      .map((profile) => ({
        ...profile,
        evidenceUpdatedAt: profile.evidenceUpdatedAt.toISOString(),
        sourceKinds: profile.sourceKinds as InterestProfileEntry['sourceKinds'],
      })),
    tags: tagRows,
    adjacencies: adjacencyRows,
    forgottenTagIds: [...forgottenIds],
    asOf: windowEnd,
  });
}

export interface PreparedDigestRun {
  runId: string;
  userId: string;
  status: 'queued' | 'skipped';
}

export interface DigestSchedulePreference {
  userId: string;
  localTime: string;
  timezone: string;
}

export interface DigestScheduleRepository {
  listEnabledPreferences(): Promise<DigestSchedulePreference[]>;
  ensureRun(input: {
    userId: string;
    scheduledLocalDate: string;
    windowEnd: Date;
    now: Date;
  }): Promise<PreparedDigestRun | null>;
}

const reusableDigestRun = (
  existing: { id: string; status: string; runLeaseUntil: Date | null },
  userId: string,
  now: Date,
): PreparedDigestRun | null => {
  if (existing.status === 'queued' || (
    existing.status === 'running'
    && existing.runLeaseUntil !== null
    && existing.runLeaseUntil <= now
  )) {
    return { runId: existing.id, userId, status: 'queued' };
  }
  return null;
};

const canonicalHttpUrl = (value: string): string | null => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
      ? canonicalizeUrl(value)
      : null;
  } catch {
    return null;
  }
};

const removeDeliveredSnapshots = (
  snapshots: readonly DigestSnapshot[],
  deliveredRows: readonly { contentKey: string; sourceUrl: string; citationUrls: string[] }[],
): DigestSnapshot[] => {
  const delivered = new Set(deliveredRows.flatMap((row) => (
    [row.contentKey, row.sourceUrl, ...row.citationUrls]
      .map(canonicalHttpUrl)
      .filter((value): value is string => value !== null)
  )));
  return snapshots.filter((snapshot) => ![
    snapshot.contentKey, snapshot.sourceUrl, ...snapshot.citationUrls,
  ].some((url) => {
    const key = canonicalHttpUrl(url);
    return key !== null && delivered.has(key);
  })).map((snapshot, position) => ({ ...snapshot, position }));
};

export class PrismaDigestScheduleRepository implements DigestScheduleRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly briefGenerator: Pick<DigestBriefGenerator, 'generate'> = new DigestBriefGenerator(),
  ) {}

  async listEnabledPreferences(): Promise<DigestSchedulePreference[]> {
    const rows = await this.prisma.digestPreference.findMany({
      where: { enabled: true },
      select: {
        userId: true, localSendTime: true,
        user: { select: { timezone: true } },
      },
      orderBy: { userId: 'asc' },
    });
    return rows.map((row) => ({
      userId: row.userId,
      localTime: row.localSendTime,
      timezone: row.user.timezone,
    }));
  }

  async ensureRun(input: {
    userId: string;
    scheduledLocalDate: string;
    windowEnd: Date;
    now: Date;
  }): Promise<PreparedDigestRun | null> {
    const preparation = await this.prisma.$transaction(async (transaction) => {
      const lockKey = `digest:${input.userId}:${input.scheduledLocalDate}`;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const existing = await transaction.digestRun.findUnique({
        where: {
          userId_scheduledLocalDate: {
            userId: input.userId,
            scheduledLocalDate: input.scheduledLocalDate,
          },
        },
        select: { id: true, status: true, runLeaseUntil: true },
      });
      if (existing) {
        return { kind: 'existing' as const, run: reusableDigestRun(existing, input.userId, input.now) };
      }
      const boundary = await transaction.digestRun.findFirst({
        where: { userId: input.userId, status: { in: ['succeeded', 'skipped'] } },
        select: { windowEnd: true },
        orderBy: [{ windowEnd: 'desc' }, { id: 'desc' }],
      });
      const windowStart = boundary?.windowEnd ?? DEFAULT_WINDOW_START;
      const snapshots = await loadDigestSnapshots(
        transaction,
        input.userId,
        windowStart,
        input.windowEnd,
      );
      return { kind: 'new' as const, snapshots };
    });
    if (preparation.kind === 'existing') return preparation.run;

    const runId = randomUUID();
    const generated = await this.briefGenerator.generate({
      runId,
      userId: input.userId,
      snapshots: preparation.snapshots,
    });
    return this.prisma.$transaction(async (transaction) => {
      const lockKey = `digest:${input.userId}:${input.scheduledLocalDate}`;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const existing = await transaction.digestRun.findUnique({
        where: {
          userId_scheduledLocalDate: {
            userId: input.userId,
            scheduledLocalDate: input.scheduledLocalDate,
          },
        },
        select: { id: true, status: true, runLeaseUntil: true },
      });
      if (existing) return reusableDigestRun(existing, input.userId, input.now);
      const [boundary, deliveredRows] = await Promise.all([
        transaction.digestRun.findFirst({
          where: { userId: input.userId, status: { in: ['succeeded', 'skipped'] } },
          select: { windowEnd: true },
          orderBy: [{ windowEnd: 'desc' }, { id: 'desc' }],
        }),
        transaction.digestItem.findMany({
          where: { run: { userId: input.userId, status: 'succeeded' } },
          select: { contentKey: true, sourceUrl: true, citationUrls: true },
        }),
      ]);
      const snapshots = removeDeliveredSnapshots(generated.items, deliveredRows);
      const skipped = snapshots.length === 0;
      const run = await transaction.digestRun.create({
        data: {
          id: runId,
          userId: input.userId,
          scheduledLocalDate: input.scheduledLocalDate,
          windowStart: boundary?.windowEnd ?? DEFAULT_WINDOW_START,
          windowEnd: input.windowEnd,
          status: skipped ? 'skipped' : 'queued',
          finishedAt: skipped ? input.now : null,
          briefGenerationStatus: generated.status,
          briefGenerationVersion: generated.version,
          briefGenerationErrorCode: generated.errorCode,
          ...(snapshots.length === 0 ? {} : { items: { create: snapshots } }),
        },
        select: { id: true },
      });
      return {
        runId: run.id,
        userId: input.userId,
        status: skipped ? 'skipped' : 'queued',
      };
    });
  }
}

export interface ClaimedDigestRun {
  runId: string;
  userId: string;
  scheduledLocalDate: string;
  recipient: string;
  leaseUntil: Date;
  items: DigestSnapshot[];
}

export interface DigestDeliveryRepository {
  claim(data: DigestJobData, now: Date, leaseUntil: Date): Promise<ClaimedDigestRun | null>;
  succeed(run: ClaimedDigestRun, messageId: string, finishedAt: Date): Promise<void>;
  retry(run: ClaimedDigestRun, errorCode: string): Promise<void>;
  fail(run: ClaimedDigestRun, errorCode: string, finishedAt: Date): Promise<void>;
  skip(run: ClaimedDigestRun, finishedAt: Date): Promise<void>;
}

const SAFE_EMAIL_ERROR_CODES = new Set([
  'EMAIL_TIMEOUT',
  'EMAIL_NETWORK_ERROR',
  'EMAIL_RATE_LIMITED',
  'EMAIL_PROVIDER_UNAVAILABLE',
  'EMAIL_RECIPIENT_REJECTED',
  'EMAIL_AUTHENTICATION_FAILED',
  'EMAIL_CONFIRMATION_LOST',
  'EMAIL_IDEMPOTENCY_CONFLICT',
  'EMAIL_GATEWAY_UNAVAILABLE',
]);

const safeEmailErrorCode = (value: string): string => (
  SAFE_EMAIL_ERROR_CODES.has(value) ? value : 'EMAIL_GATEWAY_UNAVAILABLE'
);

const safeDigestError = (code: string, retryable: boolean) => ({
  code: safeEmailErrorCode(code),
  message: retryable
    ? 'Daily digest delivery will be retried'
    : 'Daily digest delivery failed',
});

const classifyEmailFailure = (error: unknown): EmailGatewayError => (
  error instanceof EmailGatewayError
    ? error
    : new EmailGatewayError('EMAIL_GATEWAY_UNAVAILABLE', true)
);

const assertRunUpdated = (count: number): void => {
  if (count !== 1) throw new Error('Digest run lease was lost before state commit');
};

export class PrismaDigestDeliveryRepository implements DigestDeliveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(data: DigestJobData, now: Date, leaseUntil: Date): Promise<ClaimedDigestRun | null> {
    const claimed = await this.prisma.digestRun.updateMany({
      where: {
        id: data.runId,
        userId: data.userId,
        OR: [
          { status: 'queued' },
          { status: 'running', runLeaseUntil: { lte: now } },
        ],
      },
      data: {
        status: 'running',
        startedAt: now,
        runLeaseUntil: leaseUntil,
        attemptCount: { increment: 1 },
        error: Prisma.DbNull,
      },
    });
    if (claimed.count !== 1) return null;
    const run = await this.prisma.digestRun.findUnique({
      where: { id: data.runId },
      select: {
        id: true, userId: true, scheduledLocalDate: true,
        user: { select: { email: true } },
        items: { orderBy: { position: 'asc' } },
      },
    });
    if (!run || run.userId !== data.userId) return null;
    return {
      runId: run.id,
      userId: run.userId,
      scheduledLocalDate: run.scheduledLocalDate,
      recipient: run.user.email,
      leaseUntil,
      items: run.items,
    };
  }

  async succeed(run: ClaimedDigestRun, messageId: string, finishedAt: Date): Promise<void> {
    const result = await this.prisma.digestRun.updateMany({
      where: { id: run.runId, userId: run.userId, status: 'running', runLeaseUntil: run.leaseUntil },
      data: {
        status: 'succeeded',
        sentAt: finishedAt,
        finishedAt,
        providerMessageId: messageId,
        runLeaseUntil: null,
        error: Prisma.DbNull,
      },
    });
    assertRunUpdated(result.count);
  }

  async retry(run: ClaimedDigestRun, errorCode: string): Promise<void> {
    const result = await this.prisma.digestRun.updateMany({
      where: { id: run.runId, userId: run.userId, status: 'running', runLeaseUntil: run.leaseUntil },
      data: {
        status: 'queued',
        finishedAt: null,
        runLeaseUntil: null,
        error: safeDigestError(errorCode, true),
      },
    });
    assertRunUpdated(result.count);
  }

  async fail(run: ClaimedDigestRun, errorCode: string, finishedAt: Date): Promise<void> {
    const result = await this.prisma.digestRun.updateMany({
      where: { id: run.runId, userId: run.userId, status: 'running', runLeaseUntil: run.leaseUntil },
      data: {
        status: 'failed',
        finishedAt,
        runLeaseUntil: null,
        error: safeDigestError(errorCode, false),
      },
    });
    assertRunUpdated(result.count);
  }

  async skip(run: ClaimedDigestRun, finishedAt: Date): Promise<void> {
    const result = await this.prisma.digestRun.updateMany({
      where: { id: run.runId, userId: run.userId, status: 'running', runLeaseUntil: run.leaseUntil },
      data: { status: 'skipped', finishedAt, runLeaseUntil: null, error: Prisma.DbNull },
    });
    assertRunUpdated(result.count);
  }
}

export class DigestDeliveryService {
  constructor(
    private readonly repository: DigestDeliveryRepository,
    private readonly gateway: EmailGateway,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = 10 * 60_000,
  ) {}

  async run(
    data: DigestJobData,
    options: { finalAttempt: boolean } = { finalAttempt: true },
  ): Promise<void> {
    const startedAt = this.now();
    const claimed = await this.repository.claim(
      data,
      startedAt,
      new Date(startedAt.getTime() + this.leaseMs),
    );
    if (!claimed) return;
    if (claimed.items.length === 0) {
      await this.repository.skip(claimed, this.now());
      return;
    }
    let result: { messageId: string };
    try {
      result = await this.gateway.send(renderDigestEmail({
        recipient: claimed.recipient,
        scheduledLocalDate: claimed.scheduledLocalDate,
        items: claimed.items,
      }), { idempotencyKey: `digest:${claimed.runId}` });
    } catch (error) {
      const failure = classifyEmailFailure(error);
      if (failure.retryable && !options.finalAttempt) {
        await this.repository.retry(claimed, failure.code);
        throw failure;
      }
      await this.repository.fail(claimed, failure.code, this.now());
      return;
    }
    await this.repository.succeed(claimed, result.messageId, this.now());
  }
}
