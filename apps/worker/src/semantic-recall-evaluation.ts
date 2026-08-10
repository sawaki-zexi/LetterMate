import {
  feedbackInterestEventPayloadSchema,
  interestEventSchema,
  type InterestEvent,
} from '@lettermate/contracts';
import {
  evaluateSemanticRecall,
  INTEREST_ADJACENCY_VERSION,
  INTEREST_EXTRACTOR_VERSION,
  INTEREST_TAXONOMY_VERSION,
  type SemanticRecallEvaluationReport,
  type SemanticRecallWindow,
} from '@lettermate/domain';
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { readInterestEffectReport } from './interest-effect-evaluation.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

const utcDayStart = (value: Date): Date => new Date(Date.UTC(
  value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(),
));

const parseDate = (value: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('date must use YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('date is invalid');
  }
  return parsed;
};

export function parseSemanticRecallWindow(
  through: string | undefined,
  daysValue: string | undefined,
  now = new Date(),
): SemanticRecallWindow {
  const throughDay = through === undefined ? utcDayStart(now) : parseDate(through);
  const days = daysValue === undefined ? 14 : Number(daysValue);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error('days must be an integer between 1 and 365');
  }
  return {
    start: new Date(throughDay.getTime() - (days - 1) * DAY_MS),
    end: new Date(throughDay.getTime() + DAY_MS),
  };
}

const mapEvent = (row: {
  id: string;
  userId: string;
  eventType: string;
  sourceRef: string;
  payload: unknown;
  occurredAt: Date;
  recordedAt: Date;
  supersededAt: Date | null;
}): InterestEvent | null => {
  const parsed = interestEventSchema.safeParse({
    ...row,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
  });
  return parsed.success ? parsed.data : null;
};

export async function readSemanticRecallReport(
  prisma: PrismaClient,
  window: SemanticRecallWindow,
): Promise<SemanticRecallEvaluationReport> {
  const [labelRows, effectReport] = await Promise.all([
    prisma.interestEvent.findMany({
      where: {
        eventType: 'feedback_state',
        occurredAt: { gte: window.start, lt: window.end },
      },
      select: { userId: true, payload: true },
    }),
    readInterestEffectReport(prisma, window),
  ]);
  const labelPairs = labelRows.flatMap((row) => {
    const payload = feedbackInterestEventPayloadSchema.safeParse(row.payload);
    return payload.success && (payload.data.state === 'interested' || payload.data.state === 'less')
      ? [{ userId: row.userId, contentKey: payload.data.contentKey }]
      : [];
  });
  const windowImpressionFilter = { shownAt: { gte: window.start, lt: window.end } };
  const impressionRows = await prisma.feedImpression.findMany({
    where: {
      surface: 'feed',
      shownAt: { lt: window.end },
      OR: [windowImpressionFilter, ...labelPairs.map((pair) => ({
        userId: pair.userId, contentKey: pair.contentKey,
      }))],
    },
    select: {
      userId: true, contentKey: true, position: true, shownAt: true,
      decision: { select: { userId: true } },
    },
  });
  const userIds = [...new Set([
    ...labelPairs.map(({ userId }) => userId),
    ...impressionRows.map(({ userId }) => userId),
  ])];
  const [eventRows, creatorRows, resetRows, forgottenRows, tagCatalog, adjacencyRows] =
    userIds.length === 0
      ? [[], [], [], [], [], []] as const
      : await Promise.all([
          prisma.interestEvent.findMany({
            where: { userId: { in: userIds }, occurredAt: { lt: window.end } },
            select: {
              id: true, userId: true, eventType: true, sourceRef: true, payload: true,
              occurredAt: true, recordedAt: true, supersededAt: true,
            },
            orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          }),
          prisma.creatorItem.findMany({
            where: {
              userId: { in: userIds }, feedEligible: true, discoveredAt: { lt: window.end },
            },
            select: { userId: true, creatorId: true, canonicalPrimaryUrl: true, discoveredAt: true },
          }),
          prisma.interestMemorySettings.findMany({
            where: { userId: { in: userIds }, resetAt: { not: null } },
            select: { userId: true, resetAt: true },
          }),
          prisma.forgottenInterestTag.findMany({
            where: { userId: { in: userIds }, createdAt: { lt: window.end } },
            select: { userId: true, tagId: true, createdAt: true },
          }),
          prisma.interestTag.findMany({
            where: { taxonomyVersion: INTEREST_TAXONOMY_VERSION, status: 'active' },
            select: { id: true, slug: true },
          }),
          prisma.interestTagAdjacency.findMany({
            where: {
              relationVersion: INTEREST_ADJACENCY_VERSION,
              createdAt: { lt: window.end },
            },
            select: { leftTagId: true, rightTagId: true, createdAt: true },
          }),
        ]);
  const events = eventRows.flatMap((row) => {
    const event = mapEvent(row);
    return event ? [event] : [];
  });
  const contentKeys = [...new Set([
    ...events.flatMap((event) => event.eventType === 'feedback_state'
      ? [event.payload.contentKey] : []),
    ...creatorRows.map(({ canonicalPrimaryUrl }) => canonicalPrimaryUrl),
  ])];
  const contentTagRows = contentKeys.length === 0 ? [] : await prisma.contentInterestTag.findMany({
    where: {
      contentKey: { in: contentKeys },
      extractorVersion: INTEREST_EXTRACTOR_VERSION,
      createdAt: { lt: window.end },
      tag: { taxonomyVersion: INTEREST_TAXONOMY_VERSION, status: 'active' },
    },
    select: { contentKey: true, tagId: true, confidence: true, createdAt: true },
  });
  return evaluateSemanticRecall({
    window,
    events,
    tags: tagCatalog.map((tag) => ({ tagId: tag.id, slug: tag.slug })),
    contentTags: contentTagRows,
    creatorContent: creatorRows.map((row) => ({
      userId: row.userId, creatorId: row.creatorId,
      contentKey: row.canonicalPrimaryUrl, discoveredAt: row.discoveredAt,
    })),
    impressions: impressionRows.map((row) => ({
      userId: row.userId,
      decisionUserId: row.decision.userId,
      contentKey: row.contentKey,
      position: row.position,
      shownAt: row.shownAt,
    })),
    adjacencies: adjacencyRows,
    resets: resetRows.flatMap((row) => row.resetAt
      ? [{ userId: row.userId, resetAt: row.resetAt }] : []),
    forgottenTags: forgottenRows,
    subscriptionCandidateCount: effectReport.subscriptionCandidateCount,
    subscriptionImpressionCount: effectReport.subscriptionImpressionCount,
  });
}

async function main(): Promise<void> {
  const window = parseSemanticRecallWindow(process.argv[2], process.argv[3]);
  try { process.loadEnvFile(new URL('../../../.env', import.meta.url)); } catch { /* optional */ }
  const prisma = new PrismaClient();
  try {
    const report = await readSemanticRecallReport(prisma, window);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.decision === 'guardrail_failed') process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
