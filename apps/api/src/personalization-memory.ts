import type {
  FeedItem,
  InterestEvent,
  InterestMemory,
  InterestMemoryTheme,
} from '@lettermate/contracts';
import {
  applyExplorationEligibility,
  INTEREST_ADJACENCY_VERSION,
  INTEREST_DISABLED_RANKING_VERSION,
  INTEREST_EXTRACTOR_VERSION,
  INTEREST_PROFILE_POLICY_VERSION,
  INTEREST_RULES_RANKING_VERSION,
  INTEREST_TAXONOMY_VERSION,
  interestSlugFromText,
  projectInterestProfile,
  rankShadowSlate,
  type CandidateInterestTag,
  type InterestSignal,
  type InterestTagAdjacency,
  type ShadowRankedItem,
} from '@lettermate/domain';
import type { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mapInterestEvent } from './interest-events.js';

export interface ShadowSlateInput {
  userId: string;
  surface: 'feed' | 'digest';
  candidates: readonly FeedItem[];
  asOf: Date;
}

export interface PersonalizedSlate {
  decisionId: string;
  profileVersion: string;
  candidateVersion: string;
  personalizationEnabled: boolean;
  ranked: Array<Omit<ShadowRankedItem, 'score'>>;
}

export type InterestMemoryControl =
  | { type: 'set_enabled'; enabled: boolean }
  | { type: 'forget_tag'; tagId: string }
  | { type: 'clear_history' };

export interface PersonalizationMemory {
  select(input: ShadowSlateInput): Promise<PersonalizedSlate>;
  inspect(userId: string): Promise<InterestMemory>;
  control(userId: string, command: InterestMemoryControl): Promise<InterestMemory>;
}

export interface MemoryInterestTag {
  tagId: string;
  slug: string;
  displayName: string;
  kind: 'topic' | 'entity' | 'content_type';
  confidence: number;
  contentKey: string;
  createdAt: string;
}

export interface MemoryCreatorContent {
  userId: string;
  creatorId: string;
  contentKey: string;
  discoveredAt: string;
}

export interface MemoryInterestTagAdjacency extends InterestTagAdjacency {
  relationVersion: string;
}

export interface MemoryPersonalizationFacts {
  events: InterestEvent[];
  tags: MemoryInterestTag[];
  creatorContent: MemoryCreatorContent[];
  settings: Record<string, { personalizationEnabled: boolean; resetAt: string | null }>;
  forgottenTagIds: Record<string, string[]>;
  adjacencies?: MemoryInterestTagAdjacency[];
}

const hash = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

const activeEvents = (events: readonly InterestEvent[]): InterestEvent[] => events
  .filter((event) => event.supersededAt === null)
  .sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)
  ));

function buildShadow(input: {
  request: ShadowSlateInput;
  events: readonly InterestEvent[];
  tags: readonly MemoryInterestTag[];
  creatorContent: readonly MemoryCreatorContent[];
  personalizationEnabled: boolean;
  resetAt: string | null;
  forgottenTagIds: readonly string[];
  adjacencies: readonly MemoryInterestTagAdjacency[];
}) {
  const events = activeEvents(input.events);
  const tagsByContent = new Map<string, MemoryInterestTag[]>();
  const tagsBySlug = new Map<string, MemoryInterestTag>();
  for (const tag of input.tags) {
    const values = tagsByContent.get(tag.contentKey) ?? [];
    values.push(tag);
    tagsByContent.set(tag.contentKey, values);
    if (!tagsBySlug.has(tag.slug)) tagsBySlug.set(tag.slug, tag);
  }
  const activeCreatorIds = new Set(events.flatMap((event) => (
    event.eventType === 'creator_state' && event.payload.state === 'active'
      ? [event.payload.creatorId]
      : []
  )));
  const signals: InterestSignal[] = [];
  const resetAt = input.resetAt ? new Date(input.resetAt) : null;
  for (const event of events) {
    if (event.eventType === 'topic_state' && event.payload.state === 'active') {
      const slug = interestSlugFromText(event.payload.normalizedKeyword);
      const tag = slug ? tagsBySlug.get(slug) : undefined;
      if (tag) {
        signals.push({
          tagId: tag.tagId, kind: 'topic', occurredAt: event.occurredAt, confidence: 1,
        });
      }
    }
    if (
      event.eventType === 'feedback_state'
      && (event.payload.state === 'interested' || event.payload.state === 'less')
      && (!resetAt || new Date(event.occurredAt) >= resetAt)
    ) {
      for (const tag of tagsByContent.get(event.payload.contentKey) ?? []) {
        signals.push({
          tagId: tag.tagId,
          kind: event.payload.state,
          occurredAt: event.occurredAt,
          confidence: tag.confidence,
        });
      }
    }
  }
  const eligibleCreatorContent = input.creatorContent.filter((content) => (
    activeCreatorIds.has(content.creatorId)
    && (!resetAt || new Date(content.discoveredAt) >= resetAt)
  ));
  const creatorEvidence = new Map<string, { contentKeys: Set<string>; dates: Set<string> }>();
  for (const content of eligibleCreatorContent) {
    for (const tag of tagsByContent.get(content.contentKey) ?? []) {
      if (tag.kind === 'content_type' || tag.confidence < 0.75) continue;
      const evidence = creatorEvidence.get(tag.tagId) ?? {
        contentKeys: new Set<string>(), dates: new Set<string>(),
      };
      evidence.contentKeys.add(content.contentKey);
      evidence.dates.add(content.discoveredAt.slice(0, 10));
      creatorEvidence.set(tag.tagId, evidence);
    }
  }
  const eligibleCreatorTagIds = new Set([...creatorEvidence.entries()].flatMap(([tagId, evidence]) => (
    evidence.contentKeys.size >= 2 && evidence.dates.size >= 2 ? [tagId] : []
  )));
  for (const content of eligibleCreatorContent) {
    for (const tag of tagsByContent.get(content.contentKey) ?? []) {
      if (!eligibleCreatorTagIds.has(tag.tagId)) continue;
      signals.push({
        tagId: tag.tagId,
        kind: 'creator',
        occurredAt: content.discoveredAt,
        confidence: tag.confidence,
      });
    }
  }
  const latestFactAt = signals.map((signal) => signal.occurredAt).sort().at(-1);
  const hour = new Date(input.request.asOf);
  hour.setUTCMinutes(0, 0, 0);
  const projectionAsOf = latestFactAt && new Date(latestFactAt) > hour
    ? new Date(latestFactAt)
    : hour;
  const forgotten = new Set(input.forgottenTagIds);
  const profile = projectInterestProfile({ signals, asOf: projectionAsOf })
    .filter((entry) => !forgotten.has(entry.tagId));
  const candidateTags = new Map<string, CandidateInterestTag[]>(
    input.request.candidates.map((candidate) => [
      candidate.contentKey,
      (tagsByContent.get(candidate.contentKey) ?? []).map((tag) => ({
        tagId: tag.tagId,
        confidence: tag.confidence,
      })).sort((left, right) => (
        left.tagId.localeCompare(right.tagId) || right.confidence - left.confidence
      )),
    ]),
  );
  const currentAdjacencies = input.adjacencies
    .filter((relation) => relation.relationVersion === INTEREST_ADJACENCY_VERSION)
    .map(({ leftTagId, rightTagId }) => ({ leftTagId, rightTagId }))
    .sort((left, right) => (
      left.leftTagId.localeCompare(right.leftTagId)
      || left.rightTagId.localeCompare(right.rightTagId)
    ));
  const explorationCandidates = applyExplorationEligibility({
    candidates: input.request.candidates.map((item) => ({
      item,
      tags: candidateTags.get(item.contentKey) ?? [],
    })),
    profile,
    adjacencies: currentAdjacencies,
    forgottenTagIds: input.forgottenTagIds,
    surface: 'feed',
  });
  const personalizedRanked = rankShadowSlate({
    candidates: input.request.surface === 'digest'
      ? explorationCandidates.filter((candidate) => !candidate.explorationEligible)
      : explorationCandidates,
    profile,
    asOf: projectionAsOf,
  });
  const rankedByKey = new Map(personalizedRanked.map((item) => [item.contentKey, item]));
  const explorationByKey = new Map(explorationCandidates.map((candidate) => (
    [candidate.item.contentKey, candidate.explorationEligible ?? false]
  )));
  const surfaceCandidates = input.request.surface === 'digest'
    ? input.request.candidates.filter((candidate) => (
        !explorationByKey.get(candidate.contentKey)
      ))
    : input.request.candidates;
  const ranked = input.personalizationEnabled
    ? personalizedRanked
    : surfaceCandidates.map((candidate, position) => {
        const rankedItem = rankedByKey.get(candidate.contentKey);
        return {
          ...(rankedItem ? {
            ...rankedItem,
            lane: rankedItem.lane === 'exploration' ? 'trend' as const : rankedItem.lane,
            reasonCodes: rankedItem.reasonCodes.filter((reason) => (
              reason !== 'ADJACENT_EXPLORATION'
            )),
          } : {
            contentKey: candidate.contentKey,
            lane: 'trend' as const,
            isExploration: false,
            reasonCodes: [],
            score: 0,
          }),
          position,
          isExploration: false,
        };
      });
  const profileVersion = hash({
    policyVersion: INTEREST_PROFILE_POLICY_VERSION,
    projectionAsOf: projectionAsOf.toISOString(),
    profile,
    personalizationEnabled: input.personalizationEnabled,
    resetAt: input.resetAt,
    forgottenTagIds: [...forgotten].sort(),
  });
  const candidateVersion = hash({
    adjacencyVersion: INTEREST_ADJACENCY_VERSION,
    candidates: input.request.candidates.map((candidate) => ({
      contentKey: candidate.contentKey,
      tags: candidateTags.get(candidate.contentKey) ?? [],
      explorationEligible: explorationByKey.get(candidate.contentKey) ?? false,
    })),
    adjacencies: currentAdjacencies,
  });
  const requestKey = hash({
    surface: input.request.surface,
    profileVersion,
    candidateVersion,
    hour: hour.toISOString(),
    personalizationEnabled: input.personalizationEnabled,
  });
  return {
    events,
    profile,
    ranked,
    personalizationEnabled: input.personalizationEnabled,
    profileVersion,
    candidateVersion,
    requestKey,
    projectionAsOf,
  };
}

const themeSources = (sourceKinds: readonly string[]) => [
  ...(sourceKinds.includes('topic') ? ['keyword' as const] : []),
  ...(sourceKinds.includes('creator') ? ['creator' as const] : []),
  ...(sourceKinds.some((kind) => kind === 'interested' || kind === 'less')
    ? ['feedback' as const]
    : []),
];

function toMemoryView(
  settings: { personalizationEnabled: boolean; resetAt: Date | string | null },
  profiles: Array<{
    tagId: string;
    shortScore: number;
    longScore: number;
    negativeScore: number;
    evidenceUpdatedAt: Date | string;
    sourceKinds: string[];
    tag: { displayName: string; kind: 'topic' | 'entity' | 'content_type' };
  }>,
): InterestMemory {
  const themes = profiles.flatMap((profile) => {
    const sources = themeSources(profile.sourceKinds);
    if (sources.length === 0) return [];
    return [{
      theme: {
        id: profile.tagId,
        name: profile.tag.displayName,
        kind: profile.tag.kind,
        sources,
        updatedAt: profile.evidenceUpdatedAt instanceof Date
          ? profile.evidenceUpdatedAt.toISOString()
          : profile.evidenceUpdatedAt,
      } satisfies InterestMemoryTheme,
      shortScore: profile.shortScore,
      longScore: profile.longScore,
      negativeScore: profile.negativeScore,
    }];
  }).sort((left, right) => (
    right.theme.updatedAt.localeCompare(left.theme.updatedAt)
    || left.theme.name.localeCompare(right.theme.name)
  ));
  const reduced = themes.filter((item) => item.negativeScore > 0).map((item) => item.theme);
  const positive = themes.filter((item) => item.shortScore > 0 || item.longScore > 0);
  const recent = positive.filter((item) => item.shortScore > item.longScore * 1.15)
    .map((item) => item.theme);
  const recentIds = new Set(recent.map((theme) => theme.id));
  const longTerm = positive.filter((item) => !recentIds.has(item.theme.id))
    .map((item) => item.theme);
  return {
    personalizationEnabled: settings.personalizationEnabled,
    resetAt: settings.resetAt instanceof Date
      ? settings.resetAt.toISOString()
      : settings.resetAt,
    recent,
    longTerm,
    reduced,
  };
}

const withoutScores = (items: ShadowRankedItem[]): Array<Omit<ShadowRankedItem, 'score'>> => (
  items.map(({ score: _score, ...item }) => item)
);

export class MemoryPersonalizationMemory implements PersonalizationMemory {
  constructor(
    private readonly facts: () => MemoryPersonalizationFacts,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async select(input: ShadowSlateInput): Promise<PersonalizedSlate> {
    const facts = this.facts();
    const settings = facts.settings[input.userId]
      ?? { personalizationEnabled: true, resetAt: null };
    const result = buildShadow({
      request: input,
      events: facts.events.filter((event) => event.userId === input.userId),
      tags: facts.tags,
      creatorContent: facts.creatorContent.filter((item) => item.userId === input.userId),
      personalizationEnabled: settings.personalizationEnabled,
      resetAt: settings.resetAt,
      forgottenTagIds: facts.forgottenTagIds[input.userId] ?? [],
      adjacencies: facts.adjacencies ?? [],
    });
    return {
      decisionId: result.requestKey,
      profileVersion: result.profileVersion,
      candidateVersion: result.candidateVersion,
      personalizationEnabled: settings.personalizationEnabled,
      ranked: withoutScores(result.ranked),
    };
  }

  async inspect(userId: string): Promise<InterestMemory> {
    const facts = this.facts();
    const settings = facts.settings[userId] ?? { personalizationEnabled: true, resetAt: null };
    const result = buildShadow({
      request: { userId, surface: 'feed', candidates: [], asOf: this.now() },
      events: facts.events.filter((event) => event.userId === userId),
      tags: facts.tags,
      creatorContent: facts.creatorContent.filter((item) => item.userId === userId),
      personalizationEnabled: settings.personalizationEnabled,
      resetAt: settings.resetAt,
      forgottenTagIds: facts.forgottenTagIds[userId] ?? [],
      adjacencies: facts.adjacencies ?? [],
    });
    const tags = new Map(facts.tags.map((tag) => [tag.tagId, tag]));
    return toMemoryView(settings, result.profile.flatMap((profile) => {
      const tag = tags.get(profile.tagId);
      return tag ? [{ ...profile, tag }] : [];
    }));
  }

  async control(userId: string, command: InterestMemoryControl): Promise<InterestMemory> {
    const facts = this.facts();
    const settings = facts.settings[userId] ?? { personalizationEnabled: true, resetAt: null };
    facts.settings[userId] = settings;
    if (command.type === 'set_enabled') settings.personalizationEnabled = command.enabled;
    if (command.type === 'forget_tag') {
      facts.forgottenTagIds[userId] = [
        ...new Set([...(facts.forgottenTagIds[userId] ?? []), command.tagId]),
      ];
    }
    if (command.type === 'clear_history') settings.resetAt = this.now().toISOString();
    return this.inspect(userId);
  }
}

export class PrismaPersonalizationMemory implements PersonalizationMemory {
  constructor(private readonly prisma: PrismaClient) {}

  async select(input: ShadowSlateInput): Promise<PersonalizedSlate> {
    const [eventRows, settings, forgottenTags] = await Promise.all([
      this.prisma.interestEvent.findMany({
      where: { userId: input.userId, activeKey: { not: null }, supersededAt: null },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.interestMemorySettings.findUnique({ where: { userId: input.userId } }),
      this.prisma.forgottenInterestTag.findMany({
        where: { userId: input.userId }, select: { tagId: true },
      }),
    ]);
    const events = eventRows.map(mapInterestEvent);
    const activeCreatorIds = events.flatMap((event) => (
      event.eventType === 'creator_state' && event.payload.state === 'active'
        ? [event.payload.creatorId]
        : []
    ));
    const creatorItems = activeCreatorIds.length === 0 ? [] : await this.prisma.creatorItem.findMany({
      where: {
        userId: input.userId,
        creatorId: { in: activeCreatorIds },
        feedEligible: true,
        creator: { cancelledAt: null },
      },
      select: { creatorId: true, canonicalPrimaryUrl: true, discoveredAt: true },
      orderBy: [{ discoveredAt: 'desc' }, { id: 'desc' }],
      take: 500,
    });
    const contentKeys = [...new Set([
      ...input.candidates.map((candidate) => candidate.contentKey),
      ...events.flatMap((event) => event.eventType === 'feedback_state'
        ? [event.payload.contentKey]
        : []),
      ...creatorItems.map((item) => item.canonicalPrimaryUrl),
    ])];
    const topicDescriptors = new Map<string, string>();
    for (const event of events) {
      if (event.eventType !== 'topic_state' || event.payload.state !== 'active') continue;
      const slug = interestSlugFromText(event.payload.normalizedKeyword);
      if (slug && !topicDescriptors.has(slug)) topicDescriptors.set(slug, event.payload.keyword);
    }
    const [tagRows, topicTags] = await Promise.all([
      contentKeys.length === 0 ? [] : this.prisma.contentInterestTag.findMany({
        where: {
          contentKey: { in: contentKeys },
          extractorVersion: INTEREST_EXTRACTOR_VERSION,
          tag: { taxonomyVersion: INTEREST_TAXONOMY_VERSION, status: 'active' },
        },
        select: {
          contentKey: true, confidence: true, createdAt: true,
          tag: { select: { id: true, slug: true, displayName: true, kind: true } },
        },
      }),
      Promise.all([...topicDescriptors].map(([slug, displayName]) => (
        this.prisma.interestTag.upsert({
          where: {
            slug_taxonomyVersion: { slug, taxonomyVersion: INTEREST_TAXONOMY_VERSION },
          },
          create: {
            slug,
            displayName,
            kind: 'topic',
            status: 'active',
            taxonomyVersion: INTEREST_TAXONOMY_VERSION,
          },
          update: { status: 'active' },
          select: { id: true, slug: true, displayName: true, kind: true, createdAt: true },
        })
      ))),
    ]);
    const tags: MemoryInterestTag[] = [
      ...tagRows.map((row) => ({
        tagId: row.tag.id,
        slug: row.tag.slug,
        displayName: row.tag.displayName,
        kind: row.tag.kind,
        confidence: row.confidence,
        contentKey: row.contentKey,
        createdAt: row.createdAt.toISOString(),
      })),
      ...topicTags.map((tag) => ({
        tagId: tag.id,
        slug: tag.slug,
        displayName: tag.displayName,
        kind: tag.kind,
        confidence: 1,
        contentKey: `topic://${tag.slug}`,
        createdAt: tag.createdAt.toISOString(),
      })),
    ];
    const tagIds = [...new Set(tags.map((tag) => tag.tagId))];
    const adjacencyRows = tagIds.length === 0
      ? []
      : await this.prisma.interestTagAdjacency.findMany({
          where: {
            relationVersion: INTEREST_ADJACENCY_VERSION,
            OR: [
              { leftTagId: { in: tagIds } },
              { rightTagId: { in: tagIds } },
            ],
          },
          select: { leftTagId: true, rightTagId: true, relationVersion: true },
          orderBy: [{ leftTagId: 'asc' }, { rightTagId: 'asc' }],
        });
    const result = buildShadow({
      request: input,
      events,
      tags,
      creatorContent: creatorItems.map((item) => ({
        userId: input.userId,
        creatorId: item.creatorId,
        contentKey: item.canonicalPrimaryUrl,
        discoveredAt: item.discoveredAt.toISOString(),
      })),
      personalizationEnabled: settings?.personalizationEnabled ?? true,
      resetAt: settings?.resetAt?.toISOString() ?? null,
      forgottenTagIds: forgottenTags.map((tag) => tag.tagId),
      adjacencies: adjacencyRows,
    });
    const decisionId = randomUUID();
    const throughEventId = result.events.at(-1)?.id ?? null;
    const stored = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.userId}))`;
      await transaction.interestProfileVersion.upsert({
        where: {
          userId_version: { userId: input.userId, version: result.profileVersion },
        },
        create: {
          userId: input.userId,
          version: result.profileVersion,
          throughEventId,
          computedAt: result.projectionAsOf,
          policyVersion: INTEREST_PROFILE_POLICY_VERSION,
        },
        update: {},
      });
      await transaction.userInterestProfile.deleteMany({ where: { userId: input.userId } });
      if (result.profile.length > 0) {
        await transaction.userInterestProfile.createMany({
          data: result.profile.map((entry) => ({
            userId: input.userId,
            tagId: entry.tagId,
            shortScore: entry.shortScore,
            longScore: entry.longScore,
            negativeScore: entry.negativeScore,
            evidenceUpdatedAt: new Date(entry.evidenceUpdatedAt),
            computedAt: result.projectionAsOf,
            profileVersion: result.profileVersion,
            sourceKinds: entry.sourceKinds,
          })),
        });
      }
      const decision = await transaction.recommendationDecision.upsert({
        where: {
          userId_surface_requestKey: {
            userId: input.userId,
            surface: input.surface,
            requestKey: result.requestKey,
          },
        },
        create: {
          id: decisionId,
          userId: input.userId,
          surface: input.surface,
          requestKey: result.requestKey,
          profileVersion: result.profileVersion,
          rankingVersion: result.personalizationEnabled
            ? INTEREST_RULES_RANKING_VERSION
            : INTEREST_DISABLED_RANKING_VERSION,
          candidateVersion: result.candidateVersion,
          asOf: result.projectionAsOf,
        },
        update: {},
        select: { id: true },
      });
      await transaction.recommendationDecisionItem.deleteMany({
        where: { decisionId: decision.id },
      });
      if (result.ranked.length > 0) {
        await transaction.recommendationDecisionItem.createMany({
          data: result.ranked.map((item) => ({
            decisionId: decision.id,
            contentKey: item.contentKey,
            position: item.position,
            lane: item.lane,
            isExploration: item.isExploration,
            reasonCodes: item.reasonCodes,
          })),
        });
      }
      return decision;
    });
    return {
      decisionId: stored.id,
      profileVersion: result.profileVersion,
      candidateVersion: result.candidateVersion,
      personalizationEnabled: result.personalizationEnabled,
      ranked: withoutScores(result.ranked),
    };
  }

  async inspect(userId: string): Promise<InterestMemory> {
    await this.select({ userId, surface: 'feed', candidates: [], asOf: new Date() });
    const [settings, profiles] = await Promise.all([
      this.prisma.interestMemorySettings.findUnique({ where: { userId } }),
      this.prisma.userInterestProfile.findMany({
        where: { userId },
        include: { tag: { select: { displayName: true, kind: true } } },
        orderBy: [{ evidenceUpdatedAt: 'desc' }, { tagId: 'asc' }],
      }),
    ]);
    return toMemoryView(
      settings ?? { personalizationEnabled: true, resetAt: null },
      profiles,
    );
  }

  async control(userId: string, command: InterestMemoryControl): Promise<InterestMemory> {
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
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
      if (command.type === 'set_enabled') {
        await transaction.interestMemorySettings.upsert({
          where: { userId },
          create: { userId, personalizationEnabled: command.enabled },
          update: { personalizationEnabled: command.enabled },
        });
      } else if (command.type === 'forget_tag') {
        const owned = await transaction.userInterestProfile.findUnique({
          where: { userId_tagId: { userId, tagId: command.tagId } },
          select: { tagId: true },
        });
        if (owned) {
          await transaction.forgottenInterestTag.upsert({
            where: { userId_tagId: { userId, tagId: command.tagId } },
            create: { userId, tagId: command.tagId },
            update: {},
          });
          await transaction.userInterestProfile.delete({
            where: { userId_tagId: { userId, tagId: command.tagId } },
          });
        }
      } else {
        await transaction.interestMemorySettings.upsert({
          where: { userId },
          create: { userId, resetAt: now },
          update: { resetAt: now },
        });
        await transaction.userInterestProfile.deleteMany({ where: { userId } });
      }
    });
    return this.inspect(userId);
  }
}
