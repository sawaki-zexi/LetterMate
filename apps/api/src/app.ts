import { parseConfig } from '@lettermate/config';
import {
  discoveryKindSchema,
  topicInputSchema,
} from '@lettermate/contracts';
import { normalizeKeyword } from '@lettermate/domain';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  DynamicModule,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NestModule,
  NotFoundException,
  OnModuleDestroy,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
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

const STORE = Symbol('TopicStore');
const QUEUE = Symbol('TopicQueue');
const AI_CONFIGURED = Symbol('AiConfigured');

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
});

@Controller('api/v1')
class ApiController {
  constructor(
    @Inject(STORE) private readonly store: TopicStore,
    @Inject(QUEUE) private readonly queue: TopicQueue,
    @Inject(AI_CONFIGURED) private readonly aiConfigured: boolean,
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
      await this.queue.enqueue({ topicId: topic.id, userId });
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

  @Post('topics/:id/refresh')
  @HttpCode(202)
  async refreshTopic(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    this.assertAiConfigured();
    const userId = authenticatedUser(header);
    const topic = await this.store.queueRefresh(userId, id);
    if (!topic) {
      throw new NotFoundException(errorBody('NOT_FOUND', '主题不存在'));
    }
    await this.queue.enqueue({ topicId: id, userId });
    return topic;
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
    return this.store.listFeed(userId, {
      ...(filter.topicId ? { topicId: filter.topicId } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
    });
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
  ) {}

  async onModuleDestroy() {
    await this.queue.close();
    await this.store.close();
  }
}

@Module({})
class AppModule implements NestModule {
  configure() {}

  static register(
    store: TopicStore,
    queue: TopicQueue,
    aiConfigured: boolean,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [ApiController],
      providers: [
        { provide: STORE, useValue: store },
        { provide: QUEUE, useValue: queue },
        { provide: AI_CONFIGURED, useValue: aiConfigured },
        ResourceCloser,
      ],
    };
  }
}

export interface CreateApiAppOptions {
  store?: TopicStore;
  queue?: TopicQueue;
  aiConfigured?: boolean;
  webOrigin?: string;
}

export async function createApiApp(
  options: CreateApiAppOptions = {},
): Promise<INestApplication> {
  const config = parseConfig(process.env);
  const store = options.store ?? new PrismaTopicStore(new PrismaClient());
  const queue = options.queue ?? createBullTopicQueue(config.REDIS_URL);
  const aiConfigured = options.aiConfigured ?? Boolean(config.AI_API_KEY);
  const app = await NestFactory.create(
    AppModule.register(store, queue, aiConfigured),
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
