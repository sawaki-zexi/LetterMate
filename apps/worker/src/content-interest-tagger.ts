import {
  interestTagExtractionSchema,
  type DiscoveryCandidate,
  type InterestTagExtraction,
  type InterestTagSuggestion,
} from '@lettermate/contracts';
import {
  canonicalizeUrl,
  INTEREST_EXTRACTOR_VERSION,
  INTEREST_TAXONOMY_VERSION,
} from '@lettermate/domain';
import type { PrismaClient } from '@prisma/client';

export { INTEREST_EXTRACTOR_VERSION, INTEREST_TAXONOMY_VERSION };

export interface ContentForInterestTagging {
  contentKey: string;
  title: string;
  summary: string;
  reason: string;
  platform: string;
}

export interface InterestTagGateway {
  extractInterestTags(
    input: ContentForInterestTagging,
    signal?: AbortSignal,
  ): Promise<InterestTagExtraction>;
}

export interface ContentInterestTagRepository {
  save(input: {
    contentKey: string;
    tags: InterestTagSuggestion[];
    taxonomyVersion: string;
    extractorVersion: string;
  }): Promise<void>;
}

export interface ContentTaggingResult {
  contentKey: string;
  tagged: boolean;
  tagCount: number;
}

export function normalizeInterestTags(extraction: unknown): InterestTagSuggestion[] {
  const { tags } = interestTagExtractionSchema.parse(extraction);
  const selected = new Map<string, InterestTagSuggestion>();
  for (const tag of tags) {
    const current = selected.get(tag.slug);
    if (
      !current
      || tag.confidence > current.confidence
      || tag.confidence === current.confidence
        && `${tag.kind}\u0000${tag.displayName}` < `${current.kind}\u0000${current.displayName}`
    ) {
      selected.set(tag.slug, tag);
    }
  }
  return [...selected.values()].sort((left, right) => left.slug.localeCompare(right.slug));
}

export class PrismaContentInterestTagRepository implements ContentInterestTagRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(input: {
    contentKey: string;
    tags: InterestTagSuggestion[];
    taxonomyVersion: string;
    extractorVersion: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.contentInterestTag.deleteMany({
        where: { contentKey: input.contentKey, extractorVersion: input.extractorVersion },
      });
      for (const tag of input.tags) {
        const stored = await transaction.interestTag.upsert({
          where: {
            slug_taxonomyVersion: {
              slug: tag.slug,
              taxonomyVersion: input.taxonomyVersion,
            },
          },
          create: {
            slug: tag.slug,
            displayName: tag.displayName,
            kind: tag.kind,
            taxonomyVersion: input.taxonomyVersion,
          },
          update: {
            displayName: tag.displayName,
            kind: tag.kind,
            status: 'active',
          },
        });
        await transaction.contentInterestTag.create({
          data: {
            contentKey: input.contentKey,
            tagId: stored.id,
            confidence: tag.confidence,
            extractorVersion: input.extractorVersion,
          },
        });
      }
    });
  }
}

export class ContentInterestTagger {
  constructor(
    private readonly repository: ContentInterestTagRepository,
    private readonly gateway: InterestTagGateway,
  ) {}

  async tagCandidate(
    candidate: ContentForInterestTagging,
    signal?: AbortSignal,
  ): Promise<ContentTaggingResult> {
    let contentKey = candidate.contentKey;
    try {
      contentKey = canonicalizeUrl(contentKey);
      const tags = normalizeInterestTags(await this.gateway.extractInterestTags({
        ...candidate,
        contentKey,
      }, signal));
      await this.repository.save({
        contentKey,
        tags,
        taxonomyVersion: INTEREST_TAXONOMY_VERSION,
        extractorVersion: INTEREST_EXTRACTOR_VERSION,
      });
      return { contentKey, tagged: true, tagCount: tags.length };
    } catch {
      return { contentKey, tagged: false, tagCount: 0 };
    }
  }

  async tagCandidates(
    candidates: DiscoveryCandidate[],
    signal?: AbortSignal,
  ): Promise<ContentTaggingResult[]> {
    const unique = new Map<string, ContentForInterestTagging>();
    for (const candidate of candidates) {
      const sourceUrl = candidate.sourceUrls[0];
      if (!sourceUrl) continue;
      let contentKey: string;
      try { contentKey = canonicalizeUrl(sourceUrl); } catch { continue; }
      if (!unique.has(contentKey)) {
        unique.set(contentKey, {
          contentKey,
          title: candidate.title,
          summary: candidate.summary,
          reason: candidate.reason,
          platform: candidate.platform,
        });
      }
    }
    const results: ContentTaggingResult[] = [];
    const pending = [...unique.values()];
    for (let offset = 0; offset < pending.length; offset += 3) {
      results.push(...await Promise.all(
        pending.slice(offset, offset + 3).map((candidate) => this.tagCandidate(candidate, signal)),
      ));
    }
    return results;
  }
}

export async function backfillRecentInterestTags(input: {
  prisma: PrismaClient;
  tagger: ContentInterestTagger;
  since: Date;
  limit: number;
}): Promise<ContentTaggingResult[]> {
  const take = Math.max(1, Math.floor(input.limit));
  const [topicItems, radarItems, creatorItems] = await Promise.all([
    input.prisma.discoveryItem.findMany({
      where: { discoveredAt: { gte: input.since } },
      orderBy: [{ discoveredAt: 'desc' }, { id: 'desc' }],
      take,
    }),
    input.prisma.radarItem.findMany({
      where: { discoveredAt: { gte: input.since } },
      orderBy: [{ discoveredAt: 'desc' }, { id: 'desc' }],
      take,
    }),
    input.prisma.creatorItem.findMany({
      where: {
        discoveredAt: { gte: input.since },
        feedEligible: true,
        creator: { cancelledAt: null },
      },
      orderBy: [{ discoveredAt: 'desc' }, { id: 'desc' }],
      take,
    }),
  ]);
  const candidates = [...topicItems, ...radarItems, ...creatorItems]
    .sort((left, right) => right.discoveredAt.getTime() - left.discoveredAt.getTime())
    .slice(0, take)
    .map((item): DiscoveryCandidate => ({
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      reason: item.reason,
      sourceUrls: item.sourceUrls,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      sourceType: item.sourceType,
      platform: item.platform,
      authorName: item.authorName,
      authorHandle: item.authorHandle,
      externalId: item.externalId,
      provenanceKind: item.provenanceKind,
    }));
  return input.tagger.tagCandidates(candidates);
}
