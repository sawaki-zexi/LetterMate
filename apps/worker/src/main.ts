import { parseConfig } from '@lettermate/config';
import {
  discoveryQueueName,
  creatorQueueName,
  digestQueueName,
  trendQueueName,
  type DiscoveryJobData,
  type CreatorJobData,
  type DigestJobData,
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
import { createWorkerShutdown } from './lifecycle.js';
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
import { createCreatorDiscoveryService } from './creator-service.js';
import { createCreatorWorker } from './creator-worker.js';
import {
  PrismaCreatorScheduleRepository,
  CreatorScheduleService,
  startCreatorScheduler,
} from './creator-scheduler.js';
import { PrismaTrendRepository, TrendDiscoveryService } from './trend-service.js';
import { createTrendWorker } from './trend-worker.js';
import { TrendSourceRegistry } from './trends/registry.js';
import { createDiscoveryWorker } from './worker.js';
import { inspectWorkerConfiguration } from './runtime-health.js';
import {
  ContentInterestTagger,
  PrismaContentInterestTagRepository,
} from './content-interest-tagger.js';
import { createSmtpEmailGateway } from './digest-email.js';
import {
  DigestDeliveryService,
  PrismaDigestDeliveryRepository,
  PrismaDigestScheduleRepository,
} from './digest-service.js';
import { DigestScheduleService, startDigestScheduler } from './digest-scheduler.js';
import { createDigestWorker } from './digest-worker.js';
import {
  attachWorkerLogging,
  startQueueMetricsReporter,
  writeOperationalLog,
} from './observability.js';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const config = parseConfig(process.env);
const configuration = inspectWorkerConfiguration({
  DATABASE_URL: config.DATABASE_URL,
  REDIS_URL: config.REDIS_URL,
  AI_API_KEY: config.AI_API_KEY,
});

const prisma = new PrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const schedulers: Array<{ close(): void | Promise<unknown> }> = [];
const workers: Array<{ close(): void | Promise<unknown> }> = [];
const queues: Array<{ close(): void | Promise<unknown> }> = [];

if (config.SMTP_ENABLED && config.SMTP_HOST && config.SMTP_FROM) {
  const digestQueue = new Queue<DigestJobData>(digestQueueName, { connection: redis });
  const digestGateway = createSmtpEmailGateway({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTls: config.SMTP_REQUIRE_TLS,
    from: config.SMTP_FROM,
    messageIdDomain: config.SMTP_MESSAGE_ID_DOMAIN,
    connectionTimeoutMs: config.SMTP_CONNECTION_TIMEOUT_MS,
    socketTimeoutMs: config.SMTP_SOCKET_TIMEOUT_MS,
    ...(config.SMTP_USER && config.SMTP_PASSWORD
      ? { user: config.SMTP_USER, password: config.SMTP_PASSWORD }
      : {}),
  });
  const digestWorker = createDigestWorker(
    redis,
    new DigestDeliveryService(new PrismaDigestDeliveryRepository(prisma), digestGateway),
  );
  attachWorkerLogging(digestWorker, digestQueueName);
  const digestScheduler = startDigestScheduler(new DigestScheduleService(
    new PrismaDigestScheduleRepository(prisma),
    digestQueue,
  ));
  schedulers.push(digestScheduler);
  schedulers.push(startQueueMetricsReporter(digestQueueName, digestQueue));
  workers.push(digestWorker);
  queues.push(digestQueue);
} else {
  writeOperationalLog(console, {
    level: 'warn', event: 'digest.disabled',
    code: 'DIGEST_DELIVERY_NOT_CONFIGURED', dependency: 'external',
  });
}

if (!config.AI_API_KEY) {
  writeOperationalLog(console, {
    level: 'warn', event: 'discovery.disabled',
    code: 'DISCOVERY_WORKERS_NOT_STARTED', dependency: 'external',
  });
} else {
  const queue = new Queue<DiscoveryJobData>(discoveryQueueName, { connection: redis });
  const trendQueue = new Queue<TrendJobData>(trendQueueName, { connection: redis });
  const creatorQueue = new Queue<CreatorJobData>(creatorQueueName, { connection: redis });
  const gateway = new OpenRouterAiGateway({
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    webSearch: config.AI_WEB_SEARCH,
    timeoutMs: config.AI_TIMEOUT_MS,
  });
  const interestTagger = new ContentInterestTagger(
    new PrismaContentInterestTagRepository(prisma),
    gateway,
  );
  const registry = new ConnectorRegistry(createSourceConnectors(config), {
    concurrency: config.DISCOVERY_CONNECTOR_CONCURRENCY,
    timeoutMs: Math.min(config.DISCOVERY_RUN_TIMEOUT_MS, 120_000),
    onFailure: (failure) => writeOperationalLog(console, {
      level: 'warn', event: 'connector.failed', component: failure.connectorId,
      code: failure.code, dependency: 'external',
    }),
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
    interestTagger,
  });
  const worker = createDiscoveryWorker(redis, service);
  attachWorkerLogging(worker, discoveryQueueName);
  const trendRegistry = new TrendSourceRegistry(createTrendSources(config), {
    concurrency: config.DISCOVERY_CONNECTOR_CONCURRENCY,
    timeoutMs: Math.min(config.DISCOVERY_RUN_TIMEOUT_MS, 120_000),
    onFailure: (failure) => writeOperationalLog(console, {
      level: 'warn', event: 'trend-source.failed', component: failure.sourceId,
      code: failure.code, dependency: 'external',
    }),
  });
  const trendService = new TrendDiscoveryService({
    repository: new PrismaTrendRepository(
      prisma,
      config.DISCOVERY_RUN_TIMEOUT_MS + 5 * 60_000,
      config.TREND_INTERVAL_HOURS,
    ),
    trendSources: trendRegistry,
    gateway,
    connectors: registry,
    qualityPipeline: new QualityPipeline(new ContentFetcher(), gateway),
    timeoutMs: config.DISCOVERY_RUN_TIMEOUT_MS,
    interestTagger,
  });
  const trendWorker = createTrendWorker(redis, trendService, trendQueue);
  const creatorService = createCreatorDiscoveryService(
    prisma,
    gateway,
    config.DISCOVERY_RUN_TIMEOUT_MS,
    config.TWITTERAPI_IO_API_KEY,
    interestTagger,
  );
  const creatorWorker = createCreatorWorker(redis, creatorService);
  attachWorkerLogging(trendWorker, trendQueueName);
  attachWorkerLogging(creatorWorker, creatorQueueName);
  const scheduler = config.DISCOVERY_SCHEDULER_ENABLED
    ? startTopicScheduler(new TopicScheduleService(
        new PrismaTopicScheduleRepository(prisma),
        queue,
      ))
    : null;
  const trendScheduler = config.TREND_MONITOR_ENABLED
    ? startTrendScheduler(new TrendScheduleService(
        new PrismaTrendScheduleRepository(prisma, config.TREND_INTERVAL_HOURS),
        trendQueue,
      ))
    : null;
  const creatorScheduler = config.DISCOVERY_SCHEDULER_ENABLED
    ? startCreatorScheduler(new CreatorScheduleService(
        new PrismaCreatorScheduleRepository(prisma),
        creatorQueue,
      ))
    : null;

  schedulers.push(...[scheduler, trendScheduler, creatorScheduler].filter(
    (value): value is NonNullable<typeof value> => value !== null,
  ));
  schedulers.push(
    startQueueMetricsReporter(discoveryQueueName, queue),
    startQueueMetricsReporter(trendQueueName, trendQueue),
    startQueueMetricsReporter(creatorQueueName, creatorQueue),
  );
  workers.push(worker, trendWorker, creatorWorker);
  queues.push(queue, trendQueue, creatorQueue);
}

writeOperationalLog(console, {
  level: 'info', event: 'worker.started',
  code: configuration.ai === 'configured' ? 'AI_CONFIGURED' : 'AI_NOT_CONFIGURED',
});

const shutdown = createWorkerShutdown({ schedulers, workers, queues, redis, prisma });
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
