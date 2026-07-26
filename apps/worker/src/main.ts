import { parseConfig } from '@lettermate/config';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { OpenRouterAiGateway } from './openrouter-gateway.js';
import {
  PrismaDiscoveryRepository,
  TopicDiscoveryService,
} from './discovery-service.js';
import { createDiscoveryWorker } from './worker.js';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const config = parseConfig(process.env);

if (!config.AI_API_KEY) {
  console.warn('OpenRouter Key is not configured; discovery worker is not started.');
} else {
  const prisma = new PrismaClient();
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const gateway = new OpenRouterAiGateway({
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    webSearch: config.AI_WEB_SEARCH,
    timeoutMs: config.AI_TIMEOUT_MS,
  });
  const repository = new PrismaDiscoveryRepository(prisma);
  const service = new TopicDiscoveryService(gateway, repository);
  const worker = createDiscoveryWorker(redis, service, repository);

  const shutdown = async () => {
    await worker.close();
    await redis.quit();
    await prisma.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
