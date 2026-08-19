import {
  digestPreferenceSchema,
  digestPreviewSchema,
  digestRecentRunSchema,
  digestStatusSchema,
  type DigestPreference,
  type DigestPreferenceInput,
  type DigestPreview,
  type DigestRecentRun,
  type DigestStatus,
  type FeedItem,
} from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { PersonalizationMemory } from './personalization-memory.js';
import type { TopicStore } from './topic-store.js';

export class DigestPreferenceError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super('请先验证收件邮箱');
    this.name = 'DigestPreferenceError';
  }
}

export interface DigestRecipientEligibilityStore {
  get(userId: string): Promise<{ email: string | null; status: string }>;
}

export interface DigestPreferenceStore {
  get(userId: string): Promise<DigestPreference>;
  update(userId: string, input: DigestPreferenceInput): Promise<DigestPreference>;
  lastCompletedBoundary(userId: string): Promise<Date | null>;
  recentRun(userId: string): Promise<DigestRecentRun>;
}

export interface DigestService {
  getPreference(userId: string): Promise<DigestPreference>;
  updatePreference(userId: string, input: DigestPreferenceInput): Promise<DigestPreference>;
  preview(userId: string): Promise<DigestPreview>;
  status(userId: string): Promise<DigestStatus>;
}

export interface MemoryDigestFacts {
  preferences: Record<string, DigestPreference>;
  completedBoundaries?: Record<string, string | null>;
  recentRuns?: Record<string, DigestRecentRun>;
}

const defaultPreference = (): DigestPreference => ({
  enabled: false,
  localTime: '08:00',
  timezone: 'Asia/Shanghai',
});
const DIGEST_UNCERTAINTY = '邮件摘要仅基于已验证的原始来源，不替代对完整原文的独立核验。';
const DIGEST_FOLLOW_UP = '打开原文核验关键细节，并继续关注后续更新或独立来源。';

export class MemoryDigestPreferenceStore implements DigestPreferenceStore {
  constructor(private readonly facts: () => MemoryDigestFacts) {}

  async get(userId: string): Promise<DigestPreference> {
    const facts = this.facts();
    facts.preferences[userId] ??= defaultPreference();
    return digestPreferenceSchema.parse(facts.preferences[userId]);
  }

  async update(userId: string, input: DigestPreferenceInput): Promise<DigestPreference> {
    const preference = digestPreferenceSchema.parse(input);
    this.facts().preferences[userId] = preference;
    return preference;
  }

  async lastCompletedBoundary(userId: string): Promise<Date | null> {
    const value = this.facts().completedBoundaries?.[userId];
    return value ? new Date(value) : null;
  }

  async recentRun(userId: string): Promise<DigestRecentRun> {
    return digestRecentRunSchema.parse(this.facts().recentRuns?.[userId] ?? null);
  }
}

export class PrismaDigestPreferenceStore implements DigestPreferenceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async get(userId: string): Promise<DigestPreference> {
    return this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.upsert({
        where: { id: userId },
        update: {},
        create: {
          id: userId,
          email: `${userId}@example.local`,
          passwordHash: 'local-prototype-no-login-credential',
          timezone: 'Asia/Shanghai',
        },
        select: { timezone: true },
      });
      const preference = await transaction.digestPreference.upsert({
        where: { userId },
        create: { userId },
        update: {},
        select: { enabled: true, localSendTime: true },
      });
      return digestPreferenceSchema.parse({
        enabled: preference.enabled,
        localTime: preference.localSendTime,
        timezone: user.timezone,
      });
    });
  }

  async update(userId: string, input: DigestPreferenceInput): Promise<DigestPreference> {
    const parsed = digestPreferenceSchema.parse(input);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.user.upsert({
        where: { id: userId },
        update: { timezone: parsed.timezone },
        create: {
          id: userId,
          email: `${userId}@example.local`,
          passwordHash: 'local-prototype-no-login-credential',
          timezone: parsed.timezone,
        },
      });
      if (parsed.enabled) {
        const reenabled = await transaction.digestPreference.updateMany({
          where: {
            userId,
            enabled: false,
            recipientStatus: 'verified',
            recipientEmail: { not: null },
          },
          data: {
            enabled: true,
            localSendTime: parsed.localTime,
            unsubscribeTokenId: randomUUID(),
          },
        });
        if (reenabled.count === 0) {
          const updated = await transaction.digestPreference.updateMany({
            where: {
              userId,
              enabled: true,
              recipientStatus: 'verified',
              recipientEmail: { not: null },
            },
            data: { localSendTime: parsed.localTime },
          });
          if (updated.count === 1) return;
          throw new DigestPreferenceError('DIGEST_RECIPIENT_NOT_VERIFIED', 409);
        }
      } else {
        await transaction.digestPreference.upsert({
          where: { userId },
          create: { userId, enabled: false, localSendTime: parsed.localTime },
          update: { enabled: false, localSendTime: parsed.localTime },
        });
      }
    });
    return parsed;
  }

  async lastCompletedBoundary(userId: string): Promise<Date | null> {
    const run = await this.prisma.digestRun.findFirst({
      where: { userId, status: { in: ['succeeded', 'skipped'] } },
      select: { windowEnd: true },
      orderBy: [{ windowEnd: 'desc' }, { id: 'desc' }],
    });
    return run?.windowEnd ?? null;
  }

  async recentRun(userId: string): Promise<DigestRecentRun> {
    const run = await this.prisma.digestRun.findFirst({
      where: { userId },
      select: {
        status: true,
        scheduledLocalDate: true,
        finishedAt: true,
        _count: { select: { items: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return digestRecentRunSchema.parse(run ? {
      status: run.status,
      scheduledLocalDate: run.scheduledLocalDate,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      itemCount: run._count.items,
    } : null);
  }
}

const effectiveTime = (item: FeedItem): Date => new Date(
  item.publishedAt ?? item.discoveredAt,
);

const localClock = (now: Date, timezone: string): { localDate: string; localTime: string } => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}`,
  };
};

const addLocalDay = (localDate: string): string => {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

export class DefaultDigestService implements DigestService {
  constructor(
    private readonly preferences: DigestPreferenceStore,
    private readonly store: TopicStore,
    private readonly personalization: PersonalizationMemory,
    private readonly now: () => Date = () => new Date(),
    private readonly deliveryConfigured = false,
    private readonly recipients?: DigestRecipientEligibilityStore,
  ) {}

  getPreference(userId: string): Promise<DigestPreference> {
    return this.preferences.get(userId);
  }

  async updatePreference(userId: string, input: DigestPreferenceInput): Promise<DigestPreference> {
    if (input.enabled) {
      const recipient = await this.recipients?.get(userId);
      if (!recipient?.email || recipient.status !== 'verified') {
        throw new DigestPreferenceError('DIGEST_RECIPIENT_NOT_VERIFIED', 409);
      }
    }
    return this.preferences.update(userId, input);
  }

  async status(userId: string): Promise<DigestStatus> {
    const [preference, recentRun] = await Promise.all([
      this.preferences.get(userId),
      this.preferences.recentRun(userId),
    ]);
    const deliveryCapability = this.deliveryConfigured ? 'configured' : 'not_configured';
    if (!this.deliveryConfigured || !preference.enabled) {
      return digestStatusSchema.parse({
        deliveryCapability,
        nextLocalSend: null,
        recentRun,
      });
    }
    const clock = localClock(this.now(), preference.timezone);
    const terminalRunToday = recentRun?.scheduledLocalDate === clock.localDate
      && !['queued', 'running'].includes(recentRun.status);
    return digestStatusSchema.parse({
      deliveryCapability,
      nextLocalSend: {
        localDate: terminalRunToday ? addLocalDay(clock.localDate) : clock.localDate,
        localTime: preference.localTime,
        timezone: preference.timezone,
      },
      recentRun,
    });
  }

  async preview(userId: string): Promise<DigestPreview> {
    const generatedAt = this.now();
    const boundary = await this.preferences.lastCompletedBoundary(userId);
    const feedPage = await this.store.listFeed(userId, {
      origin: 'all',
      since: boundary,
      limit: 50,
      snapshotAt: generatedAt,
      windowKey: boundary?.toISOString() ?? 'all',
    });
    const feed = feedPage.items;
    const candidates = boundary
      ? feed.filter((item) => effectiveTime(item) > boundary)
      : feed;
    const selection = await this.personalization.select({
      userId,
      surface: 'digest',
      candidates,
      asOf: generatedAt,
    });
    const itemByKey = new Map(candidates.map((item) => [item.contentKey, item]));
    return digestPreviewSchema.parse({
      generatedAt: generatedAt.toISOString(),
      items: selection.ranked.slice(0, 10).flatMap((ranked) => {
        const item = itemByKey.get(ranked.contentKey);
        const citationUrls = [...new Set(item?.sourceUrls.filter((url) => {
          try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
        }) ?? [])];
        const sourceUrl = citationUrls[0];
        return item && sourceUrl ? [{
          contentKey: item.contentKey,
          title: item.title,
          summary: item.summary,
          reason: item.reason,
          sourceUrl,
          publishedAt: item.publishedAt,
          platform: item.platform,
          brief: {
            conclusion: item.summary,
            evidence: item.reason,
            uncertainty: DIGEST_UNCERTAINTY,
            followUp: DIGEST_FOLLOW_UP,
          },
          citations: citationUrls.map((url) => ({
            contentKey: item.contentKey,
            url,
            platform: item.platform,
            publishedAt: item.publishedAt,
          })),
        }] : [];
      }),
    });
  }
}
