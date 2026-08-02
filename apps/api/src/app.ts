import { parseConfig } from '@lettermate/config';
import {
  discoveryKindSchema,
  discoverySourceStatusSchema,
  feedOriginSchema,
  feedRangeSchema,
  topicInputSchema,
  topicUpdateInputSchema,
  type DiscoverySourceStatus,
} from '@lettermate/contracts';
import { normalizeKeyword } from '@lettermate/domain';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { DynamicModule, INestApplication, NestModule, OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  MemoryTopicStore,
  PrismaTopicStore,
  TopicAlreadyExistsError,
  type TopicStore,
} from './topic-store.js';
import {
  createBullTopicQueue,
  type TopicQueue,
} from './topic-queue.js';
import {
  createBullTrendQueue,
  type TrendQueue,
} from './trend-queue.js';

const STORE = Symbol('TopicStore');
const QUEUE = Symbol('TopicQueue');
const TREND_QUEUE = Symbol('TrendQueue');
const AI_CONFIGURED = Symbol('AiConfigured');
const DISCOVERY_SOURCES = Symbol('DiscoverySources');
const NOW = Symbol('Now');
const TREND_INTERVAL_HOURS = Symbol('TrendIntervalHours');

function errorBody(code: string, message: string) {
  return { code, message, traceId: randomUUID() };
}

function authenticatedUser(userId: string | undefined): string {
  if (!userId) {
    throw new UnauthorizedException(errorBody('AUTH_REQUIRED', '需要登录'));
  }
  return userId;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      ...errorBody('VALIDATION_ERROR', message),
      fieldErrors: result.error.flatten().fieldErrors,
    });
  }
  return result.data;
}

const feedFilterSchema = z.object({
  topicId: z.string().min(1).optional(),
  kind: discoveryKindSchema.optional(),
  range: feedRangeSchema.default('30d'),
  origin: feedOriginSchema.default('all'),
}).strict().superRefine((filter, context) => {
  if (filter.topicId && filter.origin === 'trend') {
    context.addIssue({
      code: 'custom', path: ['origin'],
      message: 'topicId cannot be combined with trend origin',
    });
  }
});

const feedRangeMilliseconds = {
  '1d': 24 * 60 * 60 * 1_000,
  '3d': 3 * 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
  '90d': 90 * 24 * 60 * 60 * 1_000,
} as const;

@Controller('api/v1')
class ApiController {
  constructor(
    @Inject(STORE) private readonly store: TopicStore,
    @Inject(QUEUE) private readonly queue: TopicQueue,
    @Inject(TREND_QUEUE) private readonly trendQueue: TrendQueue,
    @Inject(AI_CONFIGURED) private readonly aiConfigured: boolean,
    @Inject(DISCOVERY_SOURCES) private readonly discoverySources: DiscoverySourceStatus[],
    @Inject(NOW) private readonly now: () => Date,
    @Inject(TREND_INTERVAL_HOURS) private readonly trendIntervalHours: number,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('auth/session')
  session(@Headers('x-user-id') userId?: string) {
    const id = authenticatedUser(userId);
    return { user: { id, email: `${id}@example.local`, timezone: 'Asia/Shanghai' } };
  }

  @Post('topics')
  async createTopic(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    this.assertAiConfigured();
    const userId = authenticatedUser(header);
    const input = parseOrThrow(topicInputSchema, body, '主题关键词无效');
    try {
      const topic = await this.store.createTopic(
        userId,
        input.keyword,
        normalizeKeyword(input.keyword),
      );
      try {
        await this.queue.enqueue({ topicId: topic.id, userId, trigger: 'initial' });
      } catch (error) {
        await this.store.compensateTopicRefresh(userId, topic.id);
        throw error;
      }
      return topic;
    } catch (error) {
      if (error instanceof TopicAlreadyExistsError) {
        throw new ConflictException(
          errorBody('TOPIC_ALREADY_EXISTS', '该主题已经存在'),
        );
      }
      throw error;
    }
  }

  @Get('topics')
  listTopics(@Headers('x-user-id') header?: string) {
    return this.store.listTopics(authenticatedUser(header));
  }

  @Patch('topics/:id')
  async updateTopic(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.assertAiConfigured();
    const userId = authenticatedUser(header);
    const input = parseOrThrow(topicUpdateInputSchema, body, '关键词设置无效');
    try {
      const updated = await this.store.updateTopic(userId, id, {
        ...input,
        normalizedKeyword: normalizeKeyword(input.keyword),
      });
      if (!updated) throw new NotFoundException(errorBody('TOPIC_NOT_FOUND', '关键词不存在'));
      if (updated.shouldEnqueue) {
        try {
          await this.queue.enqueue({ topicId: id, userId, trigger: 'manual' });
        } catch (error) {
          await this.store.compensateTopicRefresh(userId, id);
          throw error;
        }
      }
      return updated.topic;
    } catch (error) {
      if (error instanceof TopicAlreadyExistsError) {
        throw new ConflictException(errorBody('TOPIC_ALREADY_EXISTS', '关键词已存在'));
      }
      throw error;
    }
  }

  @Delete('topics/:id')
  @HttpCode(204)
  async deleteTopic(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    if (!await this.store.deleteTopic(authenticatedUser(header), id)) {
      throw new NotFoundException(errorBody('TOPIC_NOT_FOUND', '关键词不存在'));
    }
  }

  @Post('topics/:id/refresh')
  @HttpCode(202)
  async refreshTopic(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    this.assertAiConfigured();
    const userId = authenticatedUser(header);
    const refresh = await this.store.queueRefresh(userId, id);
    if (!refresh) {
      throw new NotFoundException(errorBody('NOT_FOUND', '主题不存在'));
    }
    if (refresh.shouldEnqueue) {
      await this.queue.enqueue({ topicId: id, userId, trigger: 'manual' });
    }
    return refresh.topic;
  }

  @Get('feed')
  async listFeed(
    @Headers('x-user-id') header: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    const userId = authenticatedUser(header);
    const filter = parseOrThrow(feedFilterSchema, query, '发现筛选条件无效');
    if (filter.topicId && !(await this.store.findTopic(userId, filter.topicId))) {
      throw new NotFoundException(errorBody('NOT_FOUND', '主题不存在'));
    }
    const now = this.now();
    const since = filter.range === 'all'
      ? null
      : new Date(now.getTime() - feedRangeMilliseconds[filter.range]);
    return this.store.listFeed(userId, {
      origin: filter.origin,
      since,
      ...(filter.topicId ? { topicId: filter.topicId } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
    });
  }

  @Get('trends/status')
  getTrendStatus(@Headers('x-user-id') header?: string) {
    return this.store.getTrendStatus(
      authenticatedUser(header), this.trendIntervalHours, this.now(),
    );
  }

  @Post('trends/refresh')
  @HttpCode(202)
  async refreshTrends(@Headers('x-user-id') header?: string) {
    this.assertAiConfigured();
    const userId = authenticatedUser(header);
    const refresh = await this.store.queueTrendRefresh(
      userId, this.trendIntervalHours, this.now(),
    );
    if (refresh.shouldEnqueue) {
      try {
        await this.trendQueue.enqueue({
          userId,
          trigger: 'manual',
          runId: refresh.registration!.runId,
        });
      } catch (error) {
        if (refresh.registration) {
          await this.store.compensateTrendRefresh(userId, refresh.registration)
            .catch(() => false);
        }
        throw error;
      }
    }
    return refresh.status;
  }

  @Get('discovery-sources')
  listDiscoverySources(@Headers('x-user-id') header?: string) {
    authenticatedUser(header);
    return this.discoverySources;
  }

  @Get('items/:id')
  async getItem(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    const item = await this.store.findItem(authenticatedUser(header), id);
    if (!item) {
      throw new NotFoundException(errorBody('NOT_FOUND', '发现内容不存在'));
    }
    return item;
  }

  private assertAiConfigured() {
    if (!this.aiConfigured) {
      throw new ServiceUnavailableException(
        errorBody('AI_NOT_CONFIGURED', '尚未配置 OpenRouter Key'),
      );
    }
  }
}

@Injectable()
class ResourceCloser implements OnModuleDestroy {
  constructor(
    @Inject(STORE) private readonly store: TopicStore,
    @Inject(QUEUE) private readonly queue: TopicQueue,
    @Inject(TREND_QUEUE) private readonly trendQueue: TrendQueue,
  ) {}

  async onModuleDestroy() {
    await this.queue.close();
    await this.trendQueue.close();
    await this.store.close();
  }
}

@Module({})
class AppModule implements NestModule {
  configure() {}

  static register(
    store: TopicStore,
    queue: TopicQueue,
    trendQueue: TrendQueue,
    aiConfigured: boolean,
    discoverySources: DiscoverySourceStatus[],
    now: () => Date,
    trendIntervalHours: number,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [ApiController],
      providers: [
        { provide: STORE, useValue: store },
        { provide: QUEUE, useValue: queue },
        { provide: TREND_QUEUE, useValue: trendQueue },
        { provide: AI_CONFIGURED, useValue: aiConfigured },
        { provide: DISCOVERY_SOURCES, useValue: discoverySources },
        { provide: NOW, useValue: now },
        { provide: TREND_INTERVAL_HOURS, useValue: trendIntervalHours },
        ResourceCloser,
      ],
    };
  }
}

export interface CreateApiAppOptions {
  store?: TopicStore;
  queue?: TopicQueue;
  trendQueue?: TrendQueue;
  aiConfigured?: boolean;
  discoverySources?: DiscoverySourceStatus[];
  now?: () => Date;
  trendIntervalHours?: number;
  webOrigin?: string;
}

export function configuredDiscoverySources(
  config: ReturnType<typeof parseConfig>,
): DiscoverySourceStatus[] {
  const status = (enabled: boolean) => enabled ? 'enabled' as const : 'not_configured' as const;
  return discoverySourceStatusSchema.array().parse([
    {
      id: 'openrouter-search',
      label: 'OpenRouter Web Search',
      category: 'web',
      status: status(Boolean(config.AI_API_KEY && config.AI_WEB_SEARCH)),
    },
    {
      id: 'twitterapi-io',
      label: 'X',
      category: 'social',
      status: status(Boolean(config.TWITTERAPI_IO_API_KEY)),
    },
    {
      id: 'rss',
      label: 'RSS/Atom',
      category: 'feed',
      status: status(config.DISCOVERY_RSS_FEED_URLS.length > 0),
    },
    { id: 'hacker-news', label: 'Hacker News', category: 'community', status: 'enabled' },
    { id: 'arxiv', label: 'arXiv', category: 'paper', status: 'enabled' },
    { id: 'github', label: 'GitHub', category: 'code', status: 'enabled' },
    {
      id: 'search-brave',
      label: 'Brave Search',
      category: 'web',
      status: status(config.SEARCH_PROVIDER === 'brave' && Boolean(config.SEARCH_API_KEY)),
    },
    {
      id: 'youtube',
      label: 'YouTube',
      category: 'video',
      status: status(Boolean(config.YOUTUBE_API_KEY)),
    },
    {
      id: 'reddit',
      label: 'Reddit',
      category: 'community',
      status: status(Boolean(config.REDDIT_CLIENT_ID && config.REDDIT_CLIENT_SECRET)),
    },
    { id: 'bluesky', label: 'Bluesky', category: 'social', status: 'enabled' },
    { id: 'bilibili', label: 'Bilibili', category: 'video', status: 'enabled' },
    {
      id: 'x-trends', label: 'X Trends', category: 'social',
      status: status(Boolean(config.TWITTERAPI_IO_API_KEY)),
    },
    {
      id: 'hacker-news-trends', label: 'Hacker News Top Stories',
      category: 'community', status: 'enabled',
    },
    {
      id: 'youtube-trends', label: 'YouTube Most Popular', category: 'video',
      status: status(Boolean(config.YOUTUBE_API_KEY)),
    },
    {
      id: 'reddit-trends', label: 'Reddit Hot', category: 'community',
      status: status(Boolean(config.REDDIT_CLIENT_ID && config.REDDIT_CLIENT_SECRET)),
    },
    { id: 'bilibili-trends', label: 'Bilibili Popular', category: 'video', status: 'enabled' },
    {
      id: 'google-trends', label: 'Google Trends RSS', category: 'feed',
      status: status(config.TREND_GOOGLE_RSS_URLS.length > 0),
    },
  ]);
}

export async function createApiApp(
  options: CreateApiAppOptions = {},
): Promise<INestApplication> {
  const config = parseConfig(process.env);
  const store = options.store ?? new PrismaTopicStore(new PrismaClient());
  const queue = options.queue ?? createBullTopicQueue(config.REDIS_URL);
  const trendQueue = options.trendQueue ?? createBullTrendQueue(config.REDIS_URL);
  const aiConfigured = options.aiConfigured ?? Boolean(config.AI_API_KEY);
  const discoverySources = discoverySourceStatusSchema.array().parse(
    options.discoverySources ?? configuredDiscoverySources(config),
  );
  const app = await NestFactory.create(
    AppModule.register(
      store,
      queue,
      trendQueue,
      aiConfigured,
      discoverySources,
      options.now ?? (() => new Date()),
      options.trendIntervalHours ?? config.TREND_INTERVAL_HOURS,
    ),
    { logger: false },
  );
  app.enableCors({
    origin: options.webOrigin ?? config.WEB_ORIGIN,
    credentials: true,
  });
  await app.init();
  return app;
}

export { MemoryTopicStore };
