import { isEmailDeliveryConfigured, parseConfig } from '@lettermate/config';
import {
  creatorPlatformStatusSchema,
  creatorResolutionInputSchema,
  authLoginInputSchema,
  authRegisterInputSchema,
  authSessionSchema,
  digestPreferenceInputSchema,
  digestPreferenceSchema,
  digestPreviewSchema,
  digestRecipientInputSchema,
  digestRecipientSchema,
  digestRecipientVerificationInputSchema,
  digestRecipientVerificationResultSchema,
  digestStatusSchema,
  digestTestEmailSchema,
  digestUnsubscribeInputSchema,
  digestUnsubscribeResultSchema,
  discoverySourceStatusSchema,
  feedImpressionInputSchema,
  feedImpressionReceiptSchema,
  feedbackInputSchema,
  savedContentBatchInputSchema,
  savedContentBatchSchema,
  savedContentInputSchema,
  creatorInputSchema,
  creatorUpdateInputSchema,
  feedQuerySchema,
  httpUrlSchema,
  interestMemorySchema,
  interestMemorySettingsInputSchema,
  topicInputSchema,
  topicUpdateInputSchema,
  type DiscoverySourceStatus,
} from '@lettermate/contracts';
import { canonicalizeUrl, normalizeKeyword } from '@lettermate/domain';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  type RawBodyRequest,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { DynamicModule, INestApplication, NestModule, OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { checkApiReadiness, type ApiHealthChecks, type HealthProbe } from './health.js';
import { configuredDiscoverySources } from './discovery-sources.js';
import { ApiMetrics } from './metrics.js';
import { InvalidFeedCursorError } from './feed-pagination.js';
import {
  MemoryTopicStore,
  PrismaTopicStore,
  TopicAlreadyExistsError,
  CreatorAlreadyExistsError,
  type CreatorCreateInput,
  type TopicStore,
} from './topic-store.js';
import {
  createBullTopicQueue,
  type TopicQueue,
} from './topic-queue.js';
import { TopicDispatchRelay } from './topic-dispatch-outbox.js';
import {
  createBullTrendQueue,
  type TrendQueue,
} from './trend-queue.js';
import {
  createBullCreatorQueue,
  type CreatorQueue,
} from './creator-queue.js';
import {
  createBullDigestVerificationQueue,
  MemoryDigestVerificationQueue,
  type DigestVerificationQueue,
} from './digest-verification-queue.js';
import {
  CreatorResolutionError,
  CreatorResolutionService,
  RssCreatorIdentityResolver,
  XCreatorIdentityResolver,
  YouTubeCreatorIdentityResolver,
  BilibiliCreatorIdentityResolver,
  BlueskyCreatorIdentityResolver,
  type CreatorResolutionGateway,
  type ResolvedCreatorIdentity,
} from './creator-resolver.js';
import {
  MemoryPersonalizationMemory,
  PrismaPersonalizationMemory,
  type MemoryPersonalizationFacts,
  type PersonalizationMemory,
} from './personalization-memory.js';
import {
  DefaultDigestService,
  DigestPreferenceError,
  MemoryDigestPreferenceStore,
  PrismaDigestPreferenceStore,
  type DigestPreferenceStore,
  type DigestService,
  type MemoryDigestFacts,
} from './digest-service.js';
import {
  DigestRecipientError,
  DigestRecipientService,
  MemoryDigestRecipientRepository,
  PrismaDigestRecipientRepository,
} from './digest-recipient-service.js';
import {
  DigestTestEmailError,
  DigestTestEmailService,
  MemoryDigestTestEmailRepository,
  PrismaDigestTestEmailRepository,
} from './digest-test-email-service.js';
import {
  createBullDigestTestEmailQueue,
  MemoryDigestTestEmailQueue,
  type DigestTestEmailQueue,
} from './digest-test-email-queue.js';
import {
  DigestUnsubscribeError,
  DigestUnsubscribeService,
  MemoryDigestUnsubscribeRepository,
  PrismaDigestUnsubscribeRepository,
} from './digest-unsubscribe-service.js';
import {
  EmailDeliveryWebhookError,
  EmailDeliveryWebhookService,
  MemoryEmailDeliveryEventRepository,
  PrismaEmailDeliveryEventRepository,
  ResendWebhookVerifier,
} from './email-delivery-webhook-service.js';
import {
  AuthError,
  AuthService,
  MemoryAuthStore,
  PrismaAuthStore,
  authCookieNames,
  clearAuthCookies,
  createAuthMiddleware,
  parseCookies,
  setAuthCookies,
  type AuthSessionResult,
} from './auth-service.js';
import {
  createRequestTracingMiddleware,
  currentTraceId,
  type OperationalLogger,
} from './observability.js';

const STORE = Symbol('TopicStore');
const QUEUE = Symbol('TopicQueue');
const TREND_QUEUE = Symbol('TrendQueue');
const CREATOR_QUEUE = Symbol('CreatorQueue');
const DIGEST_VERIFICATION_QUEUE = Symbol('DigestVerificationQueue');
const DIGEST_TEST_EMAIL_QUEUE = Symbol('DigestTestEmailQueue');
const CREATOR_RESOLUTION = Symbol('CreatorResolution');
const AI_CONFIGURED = Symbol('AiConfigured');
const DISCOVERY_SOURCES = Symbol('DiscoverySources');
const NOW = Symbol('Now');
const TREND_INTERVAL_HOURS = Symbol('TrendIntervalHours');
const HEALTH_CHECKS = Symbol('HealthChecks');
const PERSONALIZATION_MEMORY = Symbol('PersonalizationMemory');
const DIGEST_SERVICE = Symbol('DigestService');
const DIGEST_RECIPIENT_SERVICE = Symbol('DigestRecipientService');
const DIGEST_TEST_EMAIL_SERVICE = Symbol('DigestTestEmailService');
const DIGEST_UNSUBSCRIBE_SERVICE = Symbol('DigestUnsubscribeService');
const EMAIL_DELIVERY_WEBHOOK_SERVICE = Symbol('EmailDeliveryWebhookService');
const AUTH_SERVICE = Symbol('AuthService');
const ALLOW_DEV_IDENTITY = Symbol('AllowDevIdentity');
const SECURE_COOKIES = Symbol('SecureCookies');
const API_METRICS = Symbol('ApiMetrics');
const TOPIC_DISPATCH_RELAY = Symbol('TopicDispatchRelay');

function errorBody(code: string, message: string) {
  return { code, message, traceId: currentTraceId() };
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
    @Inject(TOPIC_DISPATCH_RELAY) private readonly topicDispatchRelay: TopicDispatchRelay,
    @Inject(TREND_QUEUE) private readonly trendQueue: TrendQueue,
    @Inject(CREATOR_QUEUE) private readonly creatorQueue: CreatorQueue,
    @Inject(CREATOR_RESOLUTION) private readonly creatorResolution: CreatorResolutionGateway,
    @Inject(AI_CONFIGURED) private readonly aiConfigured: boolean,
    @Inject(DISCOVERY_SOURCES) private readonly discoverySources: DiscoverySourceStatus[],
    @Inject(NOW) private readonly now: () => Date,
    @Inject(TREND_INTERVAL_HOURS) private readonly trendIntervalHours: number,
    @Inject(HEALTH_CHECKS) private readonly healthChecks: ApiHealthChecks,
    @Inject(PERSONALIZATION_MEMORY) private readonly personalization: PersonalizationMemory,
    @Inject(DIGEST_SERVICE) private readonly digest: DigestService,
    @Inject(DIGEST_RECIPIENT_SERVICE) private readonly digestRecipient: DigestRecipientService,
    @Inject(DIGEST_TEST_EMAIL_SERVICE) private readonly digestTestEmail: DigestTestEmailService,
    @Inject(DIGEST_UNSUBSCRIBE_SERVICE) private readonly digestUnsubscribe: DigestUnsubscribeService,
    @Inject(EMAIL_DELIVERY_WEBHOOK_SERVICE)
    private readonly emailDeliveryWebhook: EmailDeliveryWebhookService,
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
    @Inject(ALLOW_DEV_IDENTITY) private readonly allowDevIdentity: boolean,
    @Inject(SECURE_COOKIES) private readonly secureCookies: boolean,
    @Inject(API_METRICS) private readonly metrics: ApiMetrics,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('health/ready')
  async readiness(@Res({ passthrough: true }) response: Response) {
    const readiness = await checkApiReadiness(this.healthChecks);
    if (readiness.status !== 'ok') response.status(503);
    return readiness;
  }

  @Get('auth/session')
  session(
    @Headers('x-user-id') userId?: string,
    @Headers('x-user-email') email?: string,
    @Headers('x-user-timezone') timezone?: string,
    @Headers('x-auth-csrf') csrfToken?: string,
  ) {
    if (!userId) return authSessionSchema.parse({ authenticated: false, user: null, csrfToken: null });
    if (this.allowDevIdentity) {
      return authSessionSchema.parse({
        authenticated: true,
        user: { id: userId, email: `${userId}@example.local`, timezone: 'Asia/Shanghai' },
        csrfToken: null,
      });
    }
    if (!email || !timezone || !csrfToken) {
      return authSessionSchema.parse({ authenticated: false, user: null, csrfToken: null });
    }
    return authSessionSchema.parse({
      authenticated: true,
      user: { id: userId, email, timezone },
      csrfToken: csrfToken ?? null,
    });
  }

  @Post('auth/register')
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parseOrThrow(authRegisterInputSchema, body, '注册信息无效');
    try {
      const result = await this.auth.register(input);
      this.setAuthCookies(response, result);
      return authSessionSchema.parse(result.session);
    } catch (error) {
      this.throwAuthError(error);
    }
  }

  @Post('auth/login')
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parseOrThrow(authLoginInputSchema, body, '登录信息无效');
    try {
      const result = await this.auth.login(input.email, input.password, request.ip ?? 'unknown');
      this.setAuthCookies(response, result);
      return authSessionSchema.parse(result.session);
    } catch (error) {
      this.throwAuthError(error);
    }
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const cookies = parseCookies(cookieHeader);
    await this.auth.logout(cookies[authCookieNames.session]);
    clearAuthCookies(response, this.secureCookies);
  }

  @Post('email-webhooks/resend')
  @HttpCode(200)
  async receiveResendWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('svix-id') id?: string,
    @Headers('svix-timestamp') timestamp?: string,
    @Headers('svix-signature') signature?: string,
  ) {
    try {
      return await this.emailDeliveryWebhook.receive(request.rawBody, {
        ...(id ? { id } : {}),
        ...(timestamp ? { timestamp } : {}),
        ...(signature ? { signature } : {}),
      });
    } catch (error) {
      if (error instanceof EmailDeliveryWebhookError) {
        throw new HttpException(errorBody(error.code, error.message), error.status);
      }
      throw error;
    }
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
      await this.topicDispatchRelay.kick();
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
        await this.topicDispatchRelay.kick();
      }
      return updated.topic;
    } catch (error) {
      if (error instanceof TopicAlreadyExistsError) {
        throw new ConflictException(errorBody('TOPIC_ALREADY_EXISTS', '关键词已存在'));
      }
      throw error;
    }
  }

  @Post('topics/:id/pause')
  @HttpCode(200)
  async pauseTopic(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    const topic = await this.store.pauseTopic(authenticatedUser(header), id);
    if (!topic) throw new NotFoundException(errorBody('TOPIC_NOT_FOUND', '关键词不存在'));
    return topic;
  }

  @Post('topics/:id/resume')
  @HttpCode(202)
  async resumeTopic(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    this.assertAiConfigured();
    const userId = authenticatedUser(header);
    const resumed = await this.store.resumeTopic(userId, id);
    if (!resumed) throw new NotFoundException(errorBody('TOPIC_NOT_FOUND', '关键词不存在'));
    if (resumed.shouldEnqueue) {
      await this.topicDispatchRelay.kick();
    }
    return resumed.topic;
  }

  @Post('creators')
  @HttpCode(202)
  async createCreator(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    this.assertAiConfigured();
    const userId = authenticatedUser(header);
    const input = parseOrThrow(creatorInputSchema, body, '博主地址无效');
    try {
      if ('url' in input) {
        const canonicalUrl = canonicalizeUrl(input.url);
        const url = new URL(canonicalUrl);
        const [creator] = await this.createAndEnqueueCreators(userId, [{
          platform: 'rss',
          accountKey: canonicalUrl,
          displayName: url.hostname,
          profileUrl: canonicalUrl,
          feedUrl: canonicalUrl,
        }]);
        return creator;
      }
      const identities = await this.creatorResolution.confirm(userId, input.resolutionTokens);
      return this.createAndEnqueueCreators(userId, identities.map(toCreatorCreateInput));
    } catch (error) {
      if (error instanceof CreatorAlreadyExistsError) {
        throw new ConflictException(errorBody('CREATOR_ALREADY_EXISTS', '该博主已经关注'));
      }
      this.throwCreatorResolutionError(error);
      throw error;
    }
  }

  @Post('creators/resolve')
  async resolveCreators(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const userId = authenticatedUser(header);
    const input = parseOrThrow(creatorResolutionInputSchema, body, '博主名字或地址无效');
    try {
      return await this.creatorResolution.resolve(userId, input.input);
    } catch (error) {
      this.throwCreatorResolutionError(error);
      throw error;
    }
  }

  @Get('creator-platforms')
  creatorPlatforms(@Headers('x-user-id') header?: string) {
    authenticatedUser(header);
    return creatorPlatformStatusSchema.array().parse(this.creatorResolution.capabilities());
  }

  @Get('creators')
  listCreators(@Headers('x-user-id') header?: string) {
    return this.store.listCreators(authenticatedUser(header));
  }

  @Patch('creators/:id')
  async updateCreator(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.assertAiConfigured();
    const userId = authenticatedUser(header);
    const input = parseOrThrow(creatorUpdateInputSchema, body, '博主关注设置无效');
    const updated = await this.store.updateCreator(userId, id, input);
    if (!updated) throw new NotFoundException(errorBody('CREATOR_NOT_FOUND', '博主关注不存在'));
    if (!input.paused) {
      const refresh = await this.store.queueCreatorRefresh(userId, id);
      if (refresh?.shouldEnqueue) {
        try {
          await this.creatorQueue.enqueue({ creatorId: id, userId, trigger: 'manual' });
        } catch (error) {
          await this.store.compensateCreatorRefresh(userId, id);
          throw error;
        }
        return refresh.creator;
      }
    }
    return updated;
  }

  @Delete('creators/:id')
  @HttpCode(204)
  async deleteCreator(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    if (!await this.store.deleteCreator(authenticatedUser(header), id)) {
      throw new NotFoundException(errorBody('CREATOR_NOT_FOUND', '博主关注不存在'));
    }
  }

  @Post('creators/:id/refresh')
  @HttpCode(202)
  async refreshCreator(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    this.assertAiConfigured();
    const userId = authenticatedUser(header);
    const refresh = await this.store.queueCreatorRefresh(userId, id);
    if (!refresh) throw new NotFoundException(errorBody('CREATOR_NOT_FOUND', '博主关注不存在'));
    if (refresh.creator.pausedAt) {
      throw new ConflictException(errorBody('CREATOR_PAUSED', '博主关注已暂停'));
    }
    if (refresh.shouldEnqueue) {
      try {
        await this.creatorQueue.enqueue({ creatorId: id, userId, trigger: 'manual' });
      } catch (error) {
        await this.store.compensateCreatorRefresh(userId, id);
        throw error;
      }
    }
    return refresh.creator;
  }

  @Get('creators/:id/items')
  async listCreatorItems(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    const items = await this.store.listCreatorItems(authenticatedUser(header), id);
    if (items === null) throw new NotFoundException(errorBody('CREATOR_NOT_FOUND', '博主关注不存在'));
    return items;
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
    if (refresh.topic.pausedAt) {
      throw new ConflictException(errorBody('TOPIC_PAUSED', '关键词监控已暂停'));
    }
    if (refresh.shouldEnqueue) {
      await this.topicDispatchRelay.kick();
    }
    return refresh.topic;
  }

  @Get('feed')
  async listFeed(
    @Headers('x-user-id') header: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    const userId = authenticatedUser(header);
    const filter = parseOrThrow(feedQuerySchema, query, '发现筛选条件无效');
    if (filter.topicId && !(await this.store.findTopic(userId, filter.topicId))) {
      throw new NotFoundException(errorBody('NOT_FOUND', '主题不存在'));
    }
    const now = this.now();
    const since = filter.range === 'all'
      ? null
      : new Date(now.getTime() - feedRangeMilliseconds[filter.range]);
    try {
      return await this.store.listFeed(userId, {
        origin: filter.origin,
        since,
        limit: filter.limit,
        windowKey: filter.range,
        snapshotAt: now,
        ...(filter.cursor ? { cursor: filter.cursor } : {}),
        ...(filter.topicId ? { topicId: filter.topicId } : {}),
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.q ? { query: filter.q } : {}),
        ...(filter.reading ? { reading: filter.reading } : {}),
      });
    } catch (error) {
      if (error instanceof InvalidFeedCursorError) {
        throw new BadRequestException(errorBody('INVALID_CURSOR', '分页游标无效'));
      }
      throw error;
    }
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

  @Get('interests')
  async getInterests(@Headers('x-user-id') header?: string) {
    return interestMemorySchema.parse(
      await this.personalization.inspect(authenticatedUser(header)),
    );
  }

  @Put('interests/settings')
  async updateInterestSettings(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const userId = authenticatedUser(header);
    const input = parseOrThrow(
      interestMemorySettingsInputSchema,
      body,
      '兴趣记忆设置无效',
    );
    return interestMemorySchema.parse(await this.personalization.control(userId, {
      type: 'set_enabled', enabled: input.personalizationEnabled,
    }));
  }

  @Delete('interests/:tagId')
  async forgetInterest(
    @Headers('x-user-id') header: string | undefined,
    @Param('tagId') tagId: string,
  ) {
    const userId = authenticatedUser(header);
    if (!tagId.trim()) {
      throw new BadRequestException(errorBody('VALIDATION_ERROR', '兴趣主题无效'));
    }
    return interestMemorySchema.parse(await this.personalization.control(userId, {
      type: 'forget_tag', tagId,
    }));
  }

  @Delete('interests')
  async clearInterestHistory(@Headers('x-user-id') header?: string) {
    const userId = authenticatedUser(header);
    return interestMemorySchema.parse(await this.personalization.control(userId, {
      type: 'clear_history',
    }));
  }

  @Get('digest-preference')
  async getDigestPreference(@Headers('x-user-id') header?: string) {
    return digestPreferenceSchema.parse(
      await this.digest.getPreference(authenticatedUser(header)),
    );
  }

  @Get('digest-recipient')
  async getDigestRecipient(@Headers('x-user-id') header?: string) {
    return digestRecipientSchema.parse(
      await this.digestRecipient.get(authenticatedUser(header)),
    );
  }

  @Post('digest-recipient/verification')
  async requestDigestRecipientVerification(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const input = parseOrThrow(digestRecipientInputSchema, body, '收件邮箱无效');
    try {
      return digestRecipientSchema.parse(await this.digestRecipient.request(
        authenticatedUser(header), input.email, request.ip ?? 'unknown',
      ));
    } catch (error) {
      this.throwDigestRecipientError(error);
    }
  }

  @Get('digest-recipient/confirm')
  async confirmDigestRecipient(@Query() query: unknown) {
    const input = parseOrThrow(
      digestRecipientVerificationInputSchema,
      query,
      '邮箱验证链接无效',
    );
    try {
      return digestRecipientVerificationResultSchema.parse(
        await this.digestRecipient.confirm(input.token),
      );
    } catch (error) {
      this.throwDigestRecipientError(error);
    }
  }

  @Get('digest/unsubscribe')
  async unsubscribeDigest(@Query() query: unknown) {
    return this.unsubscribeDigestWithToken(query);
  }

  @Post('digest/unsubscribe')
  @HttpCode(200)
  async oneClickUnsubscribeDigest(@Query() query: unknown) {
    return this.unsubscribeDigestWithToken(query);
  }

  @Put('digest-preference')
  async updateDigestPreference(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parseOrThrow(
      digestPreferenceInputSchema,
      body,
      '每日邮件设置无效',
    );
    try {
      return digestPreferenceSchema.parse(
        await this.digest.updatePreference(authenticatedUser(header), input),
      );
    } catch (error) {
      if (error instanceof DigestPreferenceError) {
        throw new HttpException(errorBody(error.code, error.message), error.status);
      }
      throw error;
    }
  }

  @Post('digest-test-email')
  async sendDigestTestEmail(@Headers('x-user-id') header?: string) {
    try {
      return digestTestEmailSchema.parse(
        await this.digestTestEmail.request(authenticatedUser(header)),
      );
    } catch (error) {
      this.throwDigestTestEmailError(error);
    }
  }

  @Get('digest-test-email/:id')
  async getDigestTestEmail(
    @Headers('x-user-id') header: string | undefined,
    @Param('id') id: string,
  ) {
    try {
      return digestTestEmailSchema.parse(
        await this.digestTestEmail.get(authenticatedUser(header), id),
      );
    } catch (error) {
      this.throwDigestTestEmailError(error);
    }
  }

  @Get('digest-preview')
  async previewDigest(@Headers('x-user-id') header?: string) {
    return digestPreviewSchema.parse(
      await this.digest.preview(authenticatedUser(header)),
    );
  }

  @Get('digest-status')
  async getDigestStatus(@Headers('x-user-id') header?: string) {
    return digestStatusSchema.parse(await this.digest.status(authenticatedUser(header)));
  }

  @Put('feedback/:contentKey')
  async setFeedback(
    @Headers('x-user-id') header: string | undefined,
    @Param('contentKey') contentKeyParam: string,
    @Body() body: unknown,
  ) {
    const userId = authenticatedUser(header);
    const contentKey = canonicalizeUrl(parseOrThrow(
      httpUrlSchema,
      contentKeyParam,
      '内容标识无效',
    ));
    const input = parseOrThrow(feedbackInputSchema, body, '反馈内容无效');
    const feedback = await this.store.setFeedback(userId, contentKey, input.value);
    if (!feedback) {
      throw new NotFoundException(errorBody('NOT_FOUND', '发现内容不存在'));
    }
    return feedback;
  }

  @Put('saved-items')
  async setSavedContentBatch(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parseOrThrow(savedContentBatchInputSchema, body, '批量归档内容无效');
    const contentKeys = input.contentKeys.map((contentKey) => canonicalizeUrl(contentKey));
    if (new Set(contentKeys).size !== contentKeys.length) {
      throw new BadRequestException(errorBody('VALIDATION_ERROR', '批量归档内容不能重复'));
    }
    const result = await this.store.setSavedContentBatch(
      authenticatedUser(header), contentKeys, input.state,
    );
    if (!result) {
      throw new NotFoundException(errorBody('NOT_FOUND', '发现内容不存在'));
    }
    return savedContentBatchSchema.parse({ items: result });
  }

  @Put('saved-items/:contentKey')
  async setSavedContent(
    @Headers('x-user-id') header: string | undefined,
    @Param('contentKey') contentKeyParam: string,
    @Body() body: unknown,
  ) {
    const userId = authenticatedUser(header);
    const contentKey = canonicalizeUrl(parseOrThrow(
      httpUrlSchema,
      contentKeyParam,
      '内容标识无效',
    ));
    const input = parseOrThrow(savedContentInputSchema, body, '保存内容无效');
    const result = await this.store.setSavedContent(userId, contentKey, input.state);
    if (!result) {
      throw new NotFoundException(errorBody('NOT_FOUND', '发现内容不存在'));
    }
    return result;
  }

  @Post('impressions')
  @HttpCode(202)
  async recordImpressions(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parseOrThrow(feedImpressionInputSchema, body, '曝光记录无效');
    const receipt = await this.store.recordFeedImpressions(authenticatedUser(header), input);
    if (!receipt) {
      this.metrics.recordFeedImpression({ status: 'rejected', recorded: 0 });
      throw new NotFoundException(errorBody('NOT_FOUND', '推荐决策不存在'));
    }
    this.metrics.recordFeedImpression({ status: 'accepted', recorded: receipt.recorded });
    return feedImpressionReceiptSchema.parse(receipt);
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

  private setAuthCookies(response: Response, result: AuthSessionResult): void {
    if (!result.session.csrfToken) throw new Error('Auth session did not produce a CSRF token');
    setAuthCookies(response, result.token, result.session.csrfToken, this.secureCookies);
  }

  private throwAuthError(error: unknown): never {
    if (error instanceof AuthError) {
      const body = errorBody(error.code, error.message);
      if (error.status === 409) throw new ConflictException(body);
      if (error.status === 429) throw new HttpException(body, 429);
      throw new UnauthorizedException(body);
    }
    throw error;
  }

  private throwDigestRecipientError(error: unknown): never {
    if (error instanceof DigestRecipientError) {
      throw new HttpException(errorBody(error.code, error.message), error.status);
    }
    throw error;
  }

  private async unsubscribeDigestWithToken(query: unknown) {
    const input = parseOrThrow(
      digestUnsubscribeInputSchema,
      query,
      '退订链接无效',
    );
    try {
      return digestUnsubscribeResultSchema.parse(
        await this.digestUnsubscribe.unsubscribe(input.token),
      );
    } catch (error) {
      if (error instanceof DigestUnsubscribeError) {
        throw new BadRequestException(errorBody(error.code, '退订链接无效'));
      }
      throw error;
    }
  }

  private throwDigestTestEmailError(error: unknown): never {
    if (error instanceof DigestTestEmailError) {
      throw new HttpException(errorBody(error.code, error.message), error.status);
    }
    throw error;
  }

  private async createAndEnqueueCreators(
    userId: string,
    inputs: CreatorCreateInput[],
  ) {
    const creators = await this.store.createCreators(userId, inputs);
    const queued = await Promise.allSettled(creators.map((creator) => this.creatorQueue.enqueue({
      creatorId: creator.id,
      userId,
      trigger: 'manual',
    })));
    const failures = queued
      .map((result, index) => ({ result, creator: creators[index]! }))
      .filter(({ result }) => result.status === 'rejected');
    if (failures.length > 0) {
      await Promise.all(failures.map(({ creator }) => (
        this.store.compensateCreatorRefresh(userId, creator.id)
      )));
      throw (failures[0]!.result as PromiseRejectedResult).reason;
    }
    return creators;
  }

  private throwCreatorResolutionError(error: unknown): void {
    if (!(error instanceof CreatorResolutionError)) return;
    const body = errorBody(error.code, error.message);
    if (error.httpStatus === 503) throw new ServiceUnavailableException(body);
    throw new BadRequestException(body);
  }
}

@Controller()
class MetricsController {
  constructor(@Inject(API_METRICS) private readonly metrics: ApiMetrics) {}

  @Get('metrics')
  async scrape(@Res() response: Response) {
    response.setHeader('content-type', this.metrics.contentType);
    response.send(await this.metrics.render());
  }
}

function toCreatorCreateInput(identity: ResolvedCreatorIdentity): CreatorCreateInput {
  return {
    platform: identity.platform,
    accountKey: identity.accountKey,
    displayName: identity.displayName,
    profileUrl: identity.profileUrl,
    feedUrl: identity.feedUrl,
  };
}

@Injectable()
class ResourceCloser implements OnModuleDestroy {
  constructor(
    @Inject(STORE) private readonly store: TopicStore,
    @Inject(TOPIC_DISPATCH_RELAY) private readonly topicDispatchRelay: TopicDispatchRelay,
    @Inject(QUEUE) private readonly queue: TopicQueue,
    @Inject(TREND_QUEUE) private readonly trendQueue: TrendQueue,
    @Inject(CREATOR_QUEUE) private readonly creatorQueue: CreatorQueue,
    @Inject(DIGEST_VERIFICATION_QUEUE) private readonly digestVerificationQueue: DigestVerificationQueue,
    @Inject(DIGEST_TEST_EMAIL_QUEUE) private readonly digestTestEmailQueue: DigestTestEmailQueue,
  ) {}

  async onModuleDestroy() {
    await this.topicDispatchRelay.close();
    await this.queue.close();
    await this.trendQueue.close();
    await this.creatorQueue.close();
    await this.digestVerificationQueue.close();
    await this.digestTestEmailQueue.close();
    await this.store.close();
  }
}

@Module({})
class AppModule implements NestModule {
  configure() {}

  static register(
    store: TopicStore,
    queue: TopicQueue,
    topicDispatchRelay: TopicDispatchRelay,
    trendQueue: TrendQueue,
    creatorQueue: CreatorQueue,
    digestVerificationQueue: DigestVerificationQueue,
    digestTestEmailQueue: DigestTestEmailQueue,
    creatorResolution: CreatorResolutionGateway,
    aiConfigured: boolean,
    discoverySources: DiscoverySourceStatus[],
    now: () => Date,
    trendIntervalHours: number,
    healthChecks: ApiHealthChecks,
    personalization: PersonalizationMemory,
    digest: DigestService,
    digestRecipient: DigestRecipientService,
    digestTestEmail: DigestTestEmailService,
    digestUnsubscribe: DigestUnsubscribeService,
    emailDeliveryWebhook: EmailDeliveryWebhookService,
    auth: AuthService,
    allowDevIdentity: boolean,
    secureCookies: boolean,
    metrics: ApiMetrics,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [ApiController, MetricsController],
      providers: [
        { provide: STORE, useValue: store },
        { provide: QUEUE, useValue: queue },
        { provide: TOPIC_DISPATCH_RELAY, useValue: topicDispatchRelay },
        { provide: TREND_QUEUE, useValue: trendQueue },
        { provide: CREATOR_QUEUE, useValue: creatorQueue },
        { provide: DIGEST_VERIFICATION_QUEUE, useValue: digestVerificationQueue },
        { provide: DIGEST_TEST_EMAIL_QUEUE, useValue: digestTestEmailQueue },
        { provide: CREATOR_RESOLUTION, useValue: creatorResolution },
        { provide: AI_CONFIGURED, useValue: aiConfigured },
        { provide: DISCOVERY_SOURCES, useValue: discoverySources },
        { provide: NOW, useValue: now },
        { provide: TREND_INTERVAL_HOURS, useValue: trendIntervalHours },
        { provide: HEALTH_CHECKS, useValue: healthChecks },
        { provide: PERSONALIZATION_MEMORY, useValue: personalization },
        { provide: DIGEST_SERVICE, useValue: digest },
        { provide: DIGEST_RECIPIENT_SERVICE, useValue: digestRecipient },
        { provide: DIGEST_TEST_EMAIL_SERVICE, useValue: digestTestEmail },
        { provide: DIGEST_UNSUBSCRIBE_SERVICE, useValue: digestUnsubscribe },
        { provide: EMAIL_DELIVERY_WEBHOOK_SERVICE, useValue: emailDeliveryWebhook },
        { provide: AUTH_SERVICE, useValue: auth },
        { provide: ALLOW_DEV_IDENTITY, useValue: allowDevIdentity },
        { provide: SECURE_COOKIES, useValue: secureCookies },
        { provide: API_METRICS, useValue: metrics },
        ResourceCloser,
      ],
    };
  }
}

export interface CreateApiAppOptions {
  store?: TopicStore;
  queue?: TopicQueue;
  topicDispatchRelay?: TopicDispatchRelay;
  trendQueue?: TrendQueue;
  creatorQueue?: CreatorQueue;
  digestVerificationQueue?: DigestVerificationQueue;
  digestTestEmailQueue?: DigestTestEmailQueue;
  creatorResolution?: CreatorResolutionGateway;
  aiConfigured?: boolean;
  discoverySources?: DiscoverySourceStatus[];
  now?: () => Date;
  trendIntervalHours?: number;
  webOrigin?: string;
  healthChecks?: Partial<Omit<ApiHealthChecks, 'aiConfigured'>>;
  personalizationMemory?: PersonalizationMemory;
  digestService?: DigestService;
  digestRecipientService?: DigestRecipientService;
  digestTestEmailService?: DigestTestEmailService;
  digestUnsubscribeService?: DigestUnsubscribeService;
  emailDeliveryWebhookService?: EmailDeliveryWebhookService;
  emailDeliveryConfigured?: boolean;
  authService?: AuthService;
  allowDevIdentity?: boolean;
  requestLogger?: OperationalLogger;
  metrics?: ApiMetrics;
  trustProxy?: boolean | number;
}

export async function createApiApp(
  options: CreateApiAppOptions = {},
): Promise<INestApplication> {
  const config = parseConfig(process.env);
  const sessionSecret = config.SESSION_SECRET ?? randomBytes(32).toString('base64url');
  const memoryFacts: MemoryPersonalizationFacts = {
    events: [], tags: [], creatorContent: [], settings: {}, forgottenTagIds: {},
  };
  const memoryDigestFacts: MemoryDigestFacts = { preferences: {} };
  let personalization = options.personalizationMemory;
  let prisma: PrismaClient | undefined;
  let digestPreferences: DigestPreferenceStore | undefined;
  const store = options.store ?? (() => {
    prisma = new PrismaClient();
    personalization ??= new PrismaPersonalizationMemory(prisma);
    digestPreferences = new PrismaDigestPreferenceStore(prisma);
    return new PrismaTopicStore(prisma, personalization, sessionSecret);
  })();
  personalization ??= new MemoryPersonalizationMemory(() => memoryFacts, options.now);
  digestPreferences ??= new MemoryDigestPreferenceStore(() => memoryDigestFacts);
  const allowDevIdentity = options.allowDevIdentity ?? config.ALLOW_DEV_IDENTITY;
  const secureCookies = config.NODE_ENV === 'production';
  const auth = options.authService ?? new AuthService(
    prisma ? new PrismaAuthStore(prisma) : new MemoryAuthStore(),
    sessionSecret,
    config.CSRF_SECRET ?? randomBytes(32).toString('base64url'),
    options.now,
  );
  const digestVerificationQueue = options.digestVerificationQueue
    ?? (prisma
      ? createBullDigestVerificationQueue(config.REDIS_URL)
      : new MemoryDigestVerificationQueue());
  const digestRecipientRepository = prisma
    ? new PrismaDigestRecipientRepository(prisma)
    : new MemoryDigestRecipientRepository((userId) => {
        const preference = memoryDigestFacts.preferences[userId];
        if (preference) memoryDigestFacts.preferences[userId] = { ...preference, enabled: false };
      });
  const digestRecipient = options.digestRecipientService ?? new DigestRecipientService(
    digestRecipientRepository,
    digestVerificationQueue,
    config.WEB_ORIGIN,
    options.emailDeliveryConfigured ?? isEmailDeliveryConfigured(config),
    undefined,
    options.now,
  );
  const digest = options.digestService ?? new DefaultDigestService(
    digestPreferences,
    store,
    personalization,
    options.now,
    options.emailDeliveryConfigured ?? isEmailDeliveryConfigured(config),
    digestRecipient,
  );
  const digestTestEmailQueue = options.digestTestEmailQueue
    ?? (prisma ? createBullDigestTestEmailQueue(config.REDIS_URL) : new MemoryDigestTestEmailQueue());
  const digestTestEmail = options.digestTestEmailService ?? new DigestTestEmailService(
    prisma ? new PrismaDigestTestEmailRepository(prisma) : new MemoryDigestTestEmailRepository(),
    digestRecipient,
    digestTestEmailQueue,
    options.emailDeliveryConfigured ?? isEmailDeliveryConfigured(config),
    options.now,
  );
  const digestUnsubscribe = options.digestUnsubscribeService ?? new DigestUnsubscribeService(
    prisma
      ? new PrismaDigestUnsubscribeRepository(prisma)
      : new MemoryDigestUnsubscribeRepository(),
    config.EMAIL_UNSUBSCRIBE_SECRET,
  );
  const emailDeliveryWebhook = options.emailDeliveryWebhookService ?? new EmailDeliveryWebhookService(
    config.RESEND_WEBHOOK_SECRET ? new ResendWebhookVerifier(config.RESEND_WEBHOOK_SECRET) : null,
    prisma
      ? new PrismaEmailDeliveryEventRepository(prisma)
      : new MemoryEmailDeliveryEventRepository(),
  );
  const queue = options.queue ?? createBullTopicQueue(config.REDIS_URL);
  const topicDispatchRelay = options.topicDispatchRelay ?? new TopicDispatchRelay(
    store.topicDispatchOutbox,
    queue,
    { ...(options.now ? { now: options.now } : {}) },
  );
  const trendQueue = options.trendQueue ?? createBullTrendQueue(config.REDIS_URL);
  const creatorQueue = options.creatorQueue ?? createBullCreatorQueue(config.REDIS_URL);
  const creatorResolution = options.creatorResolution ?? new CreatorResolutionService(
    [
      new RssCreatorIdentityResolver(),
      new XCreatorIdentityResolver(config.TWITTERAPI_IO_API_KEY),
      new BilibiliCreatorIdentityResolver(),
      new YouTubeCreatorIdentityResolver(config.YOUTUBE_API_KEY),
      new BlueskyCreatorIdentityResolver(),
    ],
    sessionSecret,
    options.now ?? (() => new Date()),
  );
  const aiConfigured = options.aiConfigured ?? Boolean(config.AI_API_KEY);
  const databaseProbe = options.healthChecks?.database ?? healthProbe(store);
  const redisProbe = options.healthChecks?.redis
    ?? healthProbe(queue)
    ?? healthProbe(trendQueue)
    ?? healthProbe(creatorQueue)
    ?? healthProbe(digestVerificationQueue)
    ?? healthProbe(digestTestEmailQueue);
  const healthChecks: ApiHealthChecks = {
    ...(databaseProbe ? { database: databaseProbe } : {}),
    ...(redisProbe ? { redis: redisProbe } : {}),
    aiConfigured,
  };
  const discoverySources = discoverySourceStatusSchema.array().parse(
    options.discoverySources ?? configuredDiscoverySources(config),
  );
  const metrics = options.metrics ?? new ApiMetrics();
  const app = await NestFactory.create(
    AppModule.register(
      store,
      queue,
      topicDispatchRelay,
      trendQueue,
      creatorQueue,
      digestVerificationQueue,
      digestTestEmailQueue,
      creatorResolution,
      aiConfigured,
      discoverySources,
      options.now ?? (() => new Date()),
      options.trendIntervalHours ?? config.TREND_INTERVAL_HOURS,
      healthChecks,
      personalization,
      digest,
      digestRecipient,
      digestTestEmail,
      digestUnsubscribe,
      emailDeliveryWebhook,
      auth,
      allowDevIdentity,
      secureCookies,
      metrics,
    ),
    { logger: false, rawBody: true },
  );
  const trustProxy = options.trustProxy ?? (config.NODE_ENV === 'production' ? 1 : false);
  if (trustProxy !== false) {
    const express = app.getHttpAdapter().getInstance() as {
      set(name: string, value: boolean | number): void;
    };
    express.set('trust proxy', trustProxy);
  }
  app.enableCors({
    origin: options.webOrigin ?? config.WEB_ORIGIN,
    credentials: true,
  });
  const requestLogger = options.requestLogger ?? (config.NODE_ENV === 'test' ? undefined : console);
  app.use(createRequestTracingMiddleware(requestLogger, options.now, metrics));
  app.use(createAuthMiddleware(auth, { allowDevIdentity, secureCookies }));
  await app.init();
  topicDispatchRelay.start();
  void topicDispatchRelay.kick();
  return app;
}

function healthProbe(value: unknown): HealthProbe | undefined {
  if (!value || typeof value !== 'object' || !('healthCheck' in value)) return undefined;
  const check = (value as { healthCheck?: unknown }).healthCheck;
  if (typeof check !== 'function') return undefined;
  return { check: () => Promise.resolve(check.call(value)) };
}

export { configuredDiscoverySources, MemoryTopicStore };
