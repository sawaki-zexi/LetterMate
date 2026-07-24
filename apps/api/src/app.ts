import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { monitorRuleInputSchema } from '@lettermate/contracts';
import { randomUUID } from 'node:crypto';
import { InMemoryStore } from './store.js';

function authenticatedUser(userId: string | undefined): string {
  if (!userId) throw new BadRequestException({ code: 'AUTH_REQUIRED', message: '需要登录', traceId: randomUUID() });
  return userId;
}

@Controller('api/v1')
class ApiController {
  constructor(@Inject(InMemoryStore) private readonly store: InMemoryStore) {}

  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('auth/session')
  session(@Headers('x-user-id') userId?: string) {
    const id = authenticatedUser(userId);
    return { user: { id, email: `${id}@example.local`, timezone: 'Asia/Shanghai' } };
  }

  @Get('monitor-rules')
  listRules(@Headers('x-user-id') userId?: string) {
    return this.store.listRules(authenticatedUser(userId));
  }

  @Get('monitor-rules/:id')
  getRule(@Headers('x-user-id') userId: string | undefined, @Param('id') id: string) {
    const rule = this.store.findRule(authenticatedUser(userId), id);
    if (!rule) throw new NotFoundException();
    return rule;
  }

  @Post('monitor-rules')
  createRule(@Headers('x-user-id') userId: string | undefined, @Body() body: unknown) {
    const result = monitorRuleInputSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: '监控规则字段无效',
        fieldErrors: result.error.flatten().fieldErrors,
        traceId: randomUUID(),
      });
    }
    return this.store.createRule(authenticatedUser(userId), result.data);
  }

  @Patch('monitor-rules/:id')
  updateRule(@Headers('x-user-id') userId: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const parsed = monitorRuleInputSchema.pick({ enabled: true }).partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: '规则更新无效', traceId: randomUUID() });
    const update = parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled };
    const rule = this.store.updateRule(authenticatedUser(userId), id, update);
    if (!rule) throw new NotFoundException();
    return rule;
  }

  @Delete('monitor-rules/:id')
  @HttpCode(204)
  deleteRule(@Headers('x-user-id') userId: string | undefined, @Param('id') id: string) {
    if (!this.store.deleteRule(authenticatedUser(userId), id)) throw new NotFoundException();
  }

  @Get('events')
  listEvents(@Headers('x-user-id') userId?: string) {
    authenticatedUser(userId);
    return this.store.events;
  }

  @Get('events/:id')
  getEvent(@Headers('x-user-id') userId: string | undefined, @Param('id') id: string) {
    authenticatedUser(userId);
    const event = this.store.events.find((item) => item.id === id);
    if (!event) throw new NotFoundException();
    return { event, evidence: this.store.evidence.filter((item) => item.eventId === id) };
  }

  @Get('notifications')
  listNotifications(@Headers('x-user-id') userId?: string) {
    return this.store.listNotifications(authenticatedUser(userId));
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  readNotification(@Headers('x-user-id') userId: string | undefined, @Param('id') id: string) {
    const notification = this.store.readNotification(authenticatedUser(userId), id);
    if (!notification) throw new NotFoundException();
    return notification;
  }

  @Get('sources')
  listSources(@Headers('x-user-id') userId?: string) {
    authenticatedUser(userId);
    return this.store.sources;
  }

  @Get('profile')
  profile(@Headers('x-user-id') userId?: string) {
    const id = authenticatedUser(userId);
    return { id, email: `${id}@example.local`, timezone: 'Asia/Shanghai', quietHours: { start: '23:00', end: '07:00' } };
  }

  @Post('push-subscriptions')
  createPushSubscription(@Headers('x-user-id') userId: string | undefined, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || !('endpoint' in body) || !('keys' in body)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Push 订阅无效', traceId: randomUUID() });
    }
    const input = body as { endpoint: unknown; keys: { p256dh?: unknown; auth?: unknown } };
    if (typeof input.endpoint !== 'string' || !URL.canParse(input.endpoint) || typeof input.keys?.p256dh !== 'string' || typeof input.keys?.auth !== 'string') {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Push 订阅无效', traceId: randomUUID() });
    }
    return this.store.addPushSubscription(authenticatedUser(userId), {
      endpoint: input.endpoint,
      keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
    });
  }

  @Delete('push-subscriptions/:id')
  @HttpCode(204)
  deletePushSubscription(@Headers('x-user-id') userId: string | undefined, @Param('id') id: string) {
    if (!this.store.deletePushSubscription(authenticatedUser(userId), id)) throw new NotFoundException();
  }

  @Post('profile/data-deletion')
  @HttpCode(202)
  deletePersonalData(@Headers('x-user-id') userId?: string) {
    const id = authenticatedUser(userId);
    this.store.deletePersonalData(id);
    return { status: 'scheduled', userId: id };
  }
}

@Module({ controllers: [ApiController], providers: [InMemoryStore] })
class AppModule {}

export async function createApiApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors({ origin: 'http://localhost:5173', credentials: true });
  await app.init();
  return app;
}
