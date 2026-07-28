import { parseConfig } from '@lettermate/config';
import {
  discoveryQueueName,
  trendQueueName,
  type DiscoveryJobData,
  type TrendJobData,
} from '@lettermate/contracts';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { ConnectorRegistry } from './connectors/registry.js';
import { ContentFetcher } from './content-fetcher.js';
import {
  PrismaDiscoveryRepository,
  TopicDiscoveryService,
} from './discovery-service.js';
import { OpenRouterAiGateway } from './openrouter-gateway.js';
import { QualityPipeline } from './quality-pipeline.js';
import { createSourceConnectors, createTrendSources } from './runtime.js';
import {
  PrismaTopicScheduleRepository,
  TopicScheduleService,
  startTopicScheduler,
} from './scheduler.js';
import {
  PrismaTrendScheduleRepository,
  TrendScheduleService,
  startTrendScheduler,
} from './trend-scheduler.js';
import { PrismaTrendRepository, TrendDiscoveryService } from './trend-service.js';
import { createTrendWorker } from './trend-worker.js';
import { TrendSourceRegistry } from './trends/registry.js';
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
  const queue = new Queue<DiscoveryJobData>(discoveryQueueName, { connection: redis });
  const trendQueue = new Queue<TrendJobData>(trendQueueName, { connection: redis });
  const gateway = new OpenRouterAiGateway({
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    webSearch: config.AI_WEB_SEARCH,
    timeoutMs: config.AI_TIMEOUT_MS,
  });
  const registry = new ConnectorRegistry(createSourceConnectors(config), {
    concurrency: config.DISCOVERY_CONNECTOR_CONCURRENCY,
    timeoutMs: Math.min(config.DISCOVERY_RUN_TIMEOUT_MS, 120_000),
  });
  const repository = new PrismaDiscoveryRepository(
    prisma,
    config.DISCOVERY_RUN_TIMEOUT_MS + 5 * 60 * 1_000,
  );
  const service = new TopicDiscoveryService({
    gateway,
    registry,
    qualityPipeline: new QualityPipeline(new ContentFetcher(), gateway),
    repository,
    timeoutMs: config.DISCOVERY_RUN_TIMEOUT_MS,
  });
  const worker = createDiscoveryWorker(redis, service);
  const trendRegistry = new TrendSourceRegistry(createTrendSources(config), {
    concurrency: config.DISCOVERY_CONNECTOR_CONCURRENCY,
    timeoutMs: Math.min(config.DISCOVERY_RUN_TIMEOUT_MS, 120_000),
  });
  const trendService = new TrendDiscoveryService({
    repository: new PrismaTrendRepository(
      prisma,
      config.DISCOVERY_RUN_TIMEOUT_MS + 5 * 60_000,
    ),
    trendSources: trendRegistry,
    gateway,
    connectors: registry,
    qualityPipeline: new QualityPipeline(new ContentFetcher(), gateway),
    timeoutMs: config.DISCOVERY_RUN_TIMEOUT_MS,
  });
  const trendWorker = createTrendWorker(redis, trendService, trendQueue);
  const scheduler = config.DISCOVERY_SCHEDULER_ENABLED
    ? startTopicScheduler(new TopicScheduleService(
        new PrismaTopicScheduleRepository(prisma),
        queue,
      ))
    : null;
  const trendScheduler = config.TREND_MONITOR_ENABLED
    ? startTrendScheduler(new TrendScheduleService(
        new PrismaTrendScheduleRepository(prisma),
        trendQueue,
      ))
    : null;

  const shutdown = async () => {
    scheduler?.close();
    trendScheduler?.close();
    await worker.close();
    await trendWorker.close();
    await queue.close();
    await trendQueue.close();
    await redis.quit();
    await prisma.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
