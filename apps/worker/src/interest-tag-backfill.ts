import { parseConfig } from '@lettermate/config';
import { PrismaClient } from '@prisma/client';
import {
  backfillRecentInterestTags,
  ContentInterestTagger,
  PrismaContentInterestTagRepository,
} from './content-interest-tagger.js';
import { OpenRouterAiGateway } from './openrouter-gateway.js';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const config = parseConfig(process.env);
if (!config.AI_API_KEY) throw new Error('AI_API_KEY is required for interest tag backfill');

const days = positiveInteger(process.env.INTEREST_BACKFILL_DAYS, 30);
const limit = positiveInteger(process.env.INTEREST_BACKFILL_LIMIT, 500);
const prisma = new PrismaClient();
try {
  const gateway = new OpenRouterAiGateway({
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    webSearch: false,
    timeoutMs: config.AI_TIMEOUT_MS,
  });
  const results = await backfillRecentInterestTags({
    prisma,
    tagger: new ContentInterestTagger(
      new PrismaContentInterestTagRepository(prisma),
      gateway,
    ),
    since: new Date(Date.now() - days * 24 * 60 * 60 * 1_000),
    limit,
  });
  const tagged = results.filter((result) => result.tagged).length;
  console.log(JSON.stringify({ scanned: results.length, tagged, failed: results.length - tagged }));
} finally {
  await prisma.$disconnect();
}
