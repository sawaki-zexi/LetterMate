import type {
  DiscoveryKind,
  FeedItem,
  FeedOrigin,
} from '@lettermate/contracts';
import { Prisma } from '@prisma/client';

export interface FeedSearchFilter {
  origin: FeedOrigin;
  topicId?: string;
  kind?: DiscoveryKind;
  since: Date | null;
  snapshotAt: Date;
  limit: number;
  query: string;
  contentKeys?: string[];
}

export interface RankedId {
  id: string;
  relevance: number;
}

export interface RankedFeedItem {
  item: FeedItem;
  relevance: number;
}

const searchableFields = [
  { name: 'title', bonus: 3, weight: 0.6 },
  { name: 'summary', bonus: 2, weight: 0.3 },
  { name: 'reason', bonus: 1, weight: 0.1 },
] as const;

const effectiveTimestamp = (item: FeedItem): string => item.publishedAt ?? item.discoveredAt;

const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

const fieldReference = (name: typeof searchableFields[number]['name']): Prisma.Sql => (
  Prisma.raw(`item."${name}"`)
);

function matchExpression(field: Prisma.Sql, pattern: string): Prisma.Sql {
  return Prisma.sql`${field} ILIKE ${pattern} ESCAPE '\\'`;
}

function relevanceExpression(query: string, pattern: string): Prisma.Sql {
  const parts = searchableFields.map(({ name, bonus, weight }) => {
    const field = fieldReference(name);
    return Prisma.sql`
      CASE WHEN ${matchExpression(field, pattern)} THEN ${bonus} ELSE 0 END
      + similarity(lower(${field}), lower(${query})) * ${weight}
    `;
  });
  return Prisma.sql`(${Prisma.join(parts, ' + ')})::double precision`;
}

function searchCondition(pattern: string): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(
    searchableFields.map(({ name }) => matchExpression(fieldReference(name), pattern)),
    ' OR ',
  )})`;
}

export function buildTopicRankQuery(
  userId: string,
  filter: FeedSearchFilter,
): Prisma.Sql {
  const pattern = `%${escapeLikePattern(filter.query)}%`;
  const conditions: Prisma.Sql[] = [
    Prisma.sql`topic."userId" = ${userId}`,
    Prisma.sql`item."discoveredAt" <= ${filter.snapshotAt}`,
    searchCondition(pattern),
  ];
  if (filter.topicId) conditions.push(Prisma.sql`item."topicId" = ${filter.topicId}`);
  if (filter.kind) {
    conditions.push(Prisma.sql`item."kind" = ${filter.kind}::"DiscoveryKind"`);
  }
  if (filter.since) {
    conditions.push(
      Prisma.sql`COALESCE(item."publishedAt", item."discoveredAt") >= ${filter.since}`,
    );
  }
  if (filter.contentKeys) {
    conditions.push(Prisma.sql`item."canonicalPrimaryUrl" IN (${Prisma.join(filter.contentKeys)})`);
  }

  return Prisma.sql`
    SELECT item."id", ${relevanceExpression(filter.query, pattern)} AS relevance
    FROM "DiscoveryItem" item
    JOIN "Topic" topic ON topic."id" = item."topicId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY relevance DESC,
      COALESCE(item."publishedAt", item."discoveredAt") DESC,
      item."id" DESC
    LIMIT ${filter.limit}
  `;
}

export function buildTrendRankQuery(
  userId: string,
  filter: FeedSearchFilter,
): Prisma.Sql {
  const pattern = `%${escapeLikePattern(filter.query)}%`;
  const conditions: Prisma.Sql[] = [
    Prisma.sql`item."userId" = ${userId}`,
    Prisma.sql`item."discoveredAt" <= ${filter.snapshotAt}`,
    searchCondition(pattern),
  ];
  if (filter.kind) {
    conditions.push(Prisma.sql`item."kind" = ${filter.kind}::"DiscoveryKind"`);
  }
  if (filter.since) {
    conditions.push(
      Prisma.sql`COALESCE(item."publishedAt", item."discoveredAt") >= ${filter.since}`,
    );
  }
  if (filter.contentKeys) {
    conditions.push(Prisma.sql`item."canonicalPrimaryUrl" IN (${Prisma.join(filter.contentKeys)})`);
  }

  return Prisma.sql`
    SELECT item."id", ${relevanceExpression(filter.query, pattern)} AS relevance
    FROM "RadarItem" item
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY relevance DESC,
      COALESCE(item."publishedAt", item."discoveredAt") DESC,
      item."id" DESC
    LIMIT ${filter.limit}
  `;
}

export function sortRankedFeed(items: RankedFeedItem[]): FeedItem[] {
  return [...items]
    .sort((left, right) => {
      const byRelevance = right.relevance - left.relevance;
      if (byRelevance) return byRelevance;
      const byTime = effectiveTimestamp(right.item).localeCompare(effectiveTimestamp(left.item));
      return byTime || right.item.id.localeCompare(left.item.id);
    })
    .map(({ item }) => item);
}

function trigramSimilarity(left: string, right: string): number {
  const trigrams = (value: string): Set<string> => {
    const characters = Array.from(`  ${value.toLocaleLowerCase()} `);
    return new Set(characters.slice(0, -2).map((_, index) => (
      characters.slice(index, index + 3).join('')
    )));
  };
  const leftTrigrams = trigrams(left);
  const rightTrigrams = trigrams(right);
  const common = [...leftTrigrams].filter((value) => rightTrigrams.has(value)).length;
  const union = new Set([...leftTrigrams, ...rightTrigrams]).size;
  return union === 0 ? 0 : common / union;
}

export function memorySearchRelevance(item: FeedItem, query: string): number | null {
  const normalizedQuery = query.toLocaleLowerCase();
  let matched = false;
  let score = 0;
  for (const { name, bonus, weight } of searchableFields) {
    const value = item[name].toLocaleLowerCase();
    const contains = value.includes(normalizedQuery);
    matched ||= contains;
    score += (contains ? bonus : 0) + trigramSimilarity(value, normalizedQuery) * weight;
  }
  return matched ? score : null;
}
