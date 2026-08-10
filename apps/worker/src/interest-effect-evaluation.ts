import { feedbackInterestEventPayloadSchema, type FeedbackValue } from '@lettermate/contracts';
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';

export interface InterestEffectWindow {
  start: Date;
  end: Date;
}

export interface InterestEffectImpression {
  userId: string;
  decisionId: string;
  contentKey: string;
  position: number;
  shownAt: Date;
  lane: 'subscription' | 'interest' | 'trend' | 'exploration';
  isExploration: boolean;
}

export interface InterestEffectFeedback {
  userId: string;
  contentKey: string;
  value: Exclude<FeedbackValue, null>;
  occurredAt: Date;
}

export interface InterestEffectDecisionItem {
  userId: string;
  decisionId: string;
  contentKey: string;
  lane: InterestEffectImpression['lane'];
  isExploration: boolean;
  createdAt: Date;
}

export interface InterestEffectReport {
  windowStart: string;
  windowEnd: string;
  decisionCount: number;
  impressionCount: number;
  uniqueUserCount: number;
  uniqueContentCount: number;
  explicitFeedbackCount: number;
  interestedFeedbackCount: number;
  lessFeedbackCount: number;
  feedbackCoverage: number;
  interestedRateAmongFeedback: number;
  lessRateAmongFeedback: number;
  subscriptionCandidateCount: number;
  subscriptionImpressionCount: number;
  subscriptionCoverage: number;
  explorationImpressionCount: number;
  explorationRate: number;
  crossUserDecisionViolationCount: number;
}

const ratio = (numerator: number, denominator: number): number => (
  denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6))
);

const withinWindow = (value: Date, window: InterestEffectWindow): boolean => (
  value >= window.start && value < window.end
);

export function utcDayWindow(value = new Date()): InterestEffectWindow {
  const start = new Date(Date.UTC(
    value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(),
  ));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1_000) };
}

export function parseUtcDay(value: string | undefined): InterestEffectWindow {
  if (value === undefined) return utcDayWindow();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('date must use YYYY-MM-DD');
  }
  const window = utcDayWindow(new Date(`${value}T00:00:00.000Z`));
  if (Number.isNaN(window.start.getTime()) || window.start.toISOString().slice(0, 10) !== value) {
    throw new Error('date is invalid');
  }
  return window;
}

export function evaluateInterestEffects(input: {
  window: InterestEffectWindow;
  decisions: readonly InterestEffectDecisionItem[];
  impressions: readonly InterestEffectImpression[];
  feedback: readonly InterestEffectFeedback[];
}): InterestEffectReport {
  const { window } = input;
  const impressions = input.impressions.filter((item) => withinWindow(item.shownAt, window));
  const decisions = input.decisions;
  const decisionUsers = new Map<string, string>();
  for (const decision of input.decisions) {
    const previous = decisionUsers.get(decision.decisionId);
    if (previous === undefined) decisionUsers.set(decision.decisionId, decision.userId);
  }
  let crossUserDecisionViolationCount = 0;
  for (const item of impressions) {
    if (decisionUsers.get(item.decisionId) !== item.userId) crossUserDecisionViolationCount += 1;
  }
  const validImpressions = impressions.filter((item) => decisionUsers.get(item.decisionId) === item.userId);
  const impressionKeys = new Set(validImpressions.map((item) => `${item.userId}\u0000${item.contentKey}`));
  const feedback = input.feedback.filter((item) => (
    withinWindow(item.occurredAt, window) && impressionKeys.has(`${item.userId}\u0000${item.contentKey}`)
  ));
  const feedbackKeys = new Set(feedback.map((item) => `${item.userId}\u0000${item.contentKey}`));
  const interestedFeedbackCount = feedback.filter((item) => item.value === 'interested').length;
  const lessFeedbackCount = feedback.filter((item) => item.value === 'less').length;
  const relevantDecisionIds = new Set(validImpressions.map((item) => `${item.userId}\u0000${item.decisionId}`));
  const subscriptionCandidates = new Set(
    decisions.filter((item) => item.lane === 'subscription'
      && relevantDecisionIds.has(`${item.userId}\u0000${item.decisionId}`))
      .map((item) => `${item.userId}\u0000${item.decisionId}\u0000${item.contentKey}`),
  );
  const subscriptionImpressions = new Set(
    validImpressions.filter((item) => item.lane === 'subscription')
      .map((item) => `${item.userId}\u0000${item.decisionId}\u0000${item.contentKey}`),
  );
  const explorationImpressionCount = validImpressions.filter((item) => item.isExploration).length;
  return {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    decisionCount: relevantDecisionIds.size,
    impressionCount: validImpressions.length,
    uniqueUserCount: new Set(validImpressions.map((item) => item.userId)).size,
    uniqueContentCount: new Set(validImpressions.map((item) => `${item.userId}\u0000${item.contentKey}`)).size,
    explicitFeedbackCount: feedbackKeys.size,
    interestedFeedbackCount,
    lessFeedbackCount,
    feedbackCoverage: ratio(feedbackKeys.size, impressionKeys.size),
    interestedRateAmongFeedback: ratio(interestedFeedbackCount, feedback.length),
    lessRateAmongFeedback: ratio(lessFeedbackCount, feedback.length),
    subscriptionCandidateCount: subscriptionCandidates.size,
    subscriptionImpressionCount: subscriptionImpressions.size,
    subscriptionCoverage: ratio(subscriptionImpressions.size, subscriptionCandidates.size),
    explorationImpressionCount,
    explorationRate: ratio(explorationImpressionCount, validImpressions.length),
    crossUserDecisionViolationCount,
  };
}

export async function readInterestEffectReport(
  prisma: PrismaClient,
  window: InterestEffectWindow,
): Promise<InterestEffectReport> {
  const [decisionRows, impressionRows, eventRows] = await Promise.all([
    prisma.recommendationDecision.findMany({
      where: {
        surface: 'feed',
        OR: [
          { createdAt: { gte: window.start, lt: window.end } },
          { impressions: { some: { shownAt: { gte: window.start, lt: window.end } } } },
        ],
      },
      select: {
        id: true, userId: true, createdAt: true,
        items: { select: { contentKey: true, lane: true, isExploration: true } },
      },
    }),
    prisma.feedImpression.findMany({
      where: { surface: 'feed', shownAt: { gte: window.start, lt: window.end } },
      select: {
        userId: true, decisionId: true, contentKey: true, position: true, shownAt: true,
        decision: { select: { items: { select: { contentKey: true, lane: true, isExploration: true } } } },
      },
    }),
    prisma.interestEvent.findMany({
      where: {
        eventType: 'feedback_state', supersededAt: null,
        occurredAt: { gte: window.start, lt: window.end },
      },
      select: { userId: true, payload: true, occurredAt: true },
    }),
  ]);
  const decisions: InterestEffectDecisionItem[] = decisionRows.flatMap((decision) => (
    decision.items.map((item) => ({
      userId: decision.userId,
      decisionId: decision.id,
      contentKey: item.contentKey,
      lane: item.lane,
      isExploration: item.isExploration,
      createdAt: decision.createdAt,
    }))
  ));
  const impressions: InterestEffectImpression[] = impressionRows.flatMap((impression) => {
    const item = impression.decision.items.find((candidate) => candidate.contentKey === impression.contentKey);
    return item ? [{
      userId: impression.userId,
      decisionId: impression.decisionId,
      contentKey: impression.contentKey,
      position: impression.position,
      shownAt: impression.shownAt,
      lane: item.lane,
      isExploration: item.isExploration,
    }] : [];
  });
  const feedback: InterestEffectFeedback[] = eventRows.flatMap((event) => {
    const parsed = feedbackInterestEventPayloadSchema.safeParse(event.payload);
    if (!parsed.success || (parsed.data.state !== 'interested' && parsed.data.state !== 'less')) return [];
    return [{
      userId: event.userId,
      contentKey: parsed.data.contentKey,
      value: parsed.data.state,
      occurredAt: event.occurredAt,
    }];
  });
  return evaluateInterestEffects({ window, decisions, impressions, feedback });
}

async function main(): Promise<void> {
  const window = parseUtcDay(process.argv[2]);
  try { process.loadEnvFile(new URL('../../../.env', import.meta.url)); } catch { /* optional */ }
  const prisma = new PrismaClient();
  try {
    const report = await readInterestEffectReport(prisma, window);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
