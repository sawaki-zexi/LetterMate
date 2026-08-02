import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import { buildTopicRankQuery, buildTrendRankQuery } from './feed-search.js';
import { PrismaTopicStore } from './topic-store.js';

const databaseIt = process.env.RUN_DATABASE_TESTS === '1' ? it : it.skip;

databaseIt('executes owner-scoped Topic and trend rank queries in PostgreSQL', async () => {
  const prisma = new PrismaClient();
  try {
    const filter = { origin: 'all' as const, since: null, query: 'AI Agent' };
    const [topicMatches, trendMatches, escapedMatches] = await Promise.all([
      prisma.$queryRaw(buildTopicRankQuery('user-a', filter)),
      prisma.$queryRaw(buildTrendRankQuery('user-a', filter)),
      prisma.$queryRaw(buildTopicRankQuery('user-a', {
        ...filter,
        query: '100%_\\',
      })),
    ]);

    expect(topicMatches).toBeInstanceOf(Array);
    expect(trendMatches).toBeInstanceOf(Array);
    expect(escapedMatches).toBeInstanceOf(Array);

    const items = await new PrismaTopicStore(prisma).listFeed('user-a', {
      origin: 'all', since: null, query: filter.query,
    });
    expect(items.every((item) => (
      `${item.title}\n${item.summary}\n${item.reason}`
        .toLocaleLowerCase()
        .includes(filter.query.toLocaleLowerCase())
    ))).toBe(true);
  } finally {
    await prisma.$disconnect();
  }
});
