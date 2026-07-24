import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp } from './app.js';

describe('phase one API', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await createApiApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a high priority monitor rule for the authenticated user', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/monitor-rules')
      .set('x-user-id', 'user-a')
      .send({
        name: 'AI Agent',
        keywords: ['AI Agent'],
        synonyms: ['智能体'],
        exclusions: ['招聘'],
        scope: { mode: 'all' },
        priority: 'high',
        notifyImmediately: true,
      })
      .expect(201);

    expect(response.body).toMatchObject({ userId: 'user-a', priority: 'high' });
  });

  it('does not expose another users monitor rule', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/monitor-rules')
      .set('x-user-id', 'user-b')
      .send({ name: 'Private', keywords: ['private'], scope: { mode: 'all' } });

    await request(app.getHttpServer())
      .get(`/api/v1/monitor-rules/${created.body.id}`)
      .set('x-user-id', 'user-a')
      .expect(404);
  });

  it('returns a confirmed event with its evidence chain', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/events/event-confirmed')
      .set('x-user-id', 'user-a')
      .expect(200);

    expect(response.body.event.status).toBe('confirmed');
    expect(response.body.evidence).toHaveLength(2);
  });

  it('marks only the authenticated users notification as read', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/notifications/notification-a/read')
      .set('x-user-id', 'user-a')
      .expect(200);

    expect(response.body.status).toBe('read');
    await request(app.getHttpServer())
      .post('/api/v1/notifications/notification-b/read')
      .set('x-user-id', 'user-a')
      .expect(404);
  });

  it('returns a trace id for invalid input', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/monitor-rules')
      .set('x-user-id', 'user-a')
      .send({ name: '', keywords: [] })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(response.body.traceId).toEqual(expect.any(String));
  });

  it('pauses and deletes only the authenticated users rule', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/monitor-rules')
      .set('x-user-id', 'user-a')
      .send({ name: 'Pause me', keywords: ['agent'], scope: { mode: 'all' } });

    const paused = await request(app.getHttpServer())
      .patch(`/api/v1/monitor-rules/${created.body.id}`)
      .set('x-user-id', 'user-a')
      .send({ enabled: false })
      .expect(200);
    expect(paused.body.enabled).toBe(false);

    await request(app.getHttpServer())
      .delete(`/api/v1/monitor-rules/${created.body.id}`)
      .set('x-user-id', 'user-b')
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/monitor-rules/${created.body.id}`)
      .set('x-user-id', 'user-a')
      .expect(204);
  });

  it('registers and removes a user-scoped Push subscription', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/push-subscriptions')
      .set('x-user-id', 'user-a')
      .send({ endpoint: 'https://push.example.test/subscription-a', keys: { p256dh: 'public-key', auth: 'auth-key' } })
      .expect(201);

    expect(created.body.endpoint).toContain('push.example.test');
    await request(app.getHttpServer())
      .delete(`/api/v1/push-subscriptions/${created.body.id}`)
      .set('x-user-id', 'user-b')
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/push-subscriptions/${created.body.id}`)
      .set('x-user-id', 'user-a')
      .expect(204);
  });

  it('accepts an authenticated personal data deletion request', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/profile/data-deletion')
      .set('x-user-id', 'user-a')
      .expect(202);
    expect(response.body).toMatchObject({ status: 'scheduled', userId: 'user-a' });
  });
});
