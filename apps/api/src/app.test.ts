import type {
  DiscoveryJobData,
  DiscoverySourceStatus,
  CreatorJobData,
  TrendJobData,
} from '@lettermate/contracts';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configuredDiscoverySources, createApiApp } from './app.js';
import { parseConfig } from '@lettermate/config';
import { MemoryTopicStore } from './topic-store.js';
import type { TopicQueue } from './topic-queue.js';
import type { TrendQueue } from './trend-queue.js';
import type { CreatorQueue } from './creator-queue.js';
import {
  MemoryPersonalizationMemory,
  type MemoryPersonalizationFacts,
} from './personalization-memory.js';
import {
  CreatorResolutionService,
  type CreatorIdentityResolver,
} from './creator-resolver.js';
import { AuthService, MemoryAuthRateLimiter, MemoryAuthStore } from './auth-service.js';

class RecordingQueue implements TopicQueue {
  jobs: DiscoveryJobData[] = [];

  async enqueue(data: DiscoveryJobData) {
    this.jobs.push(data);
  }

  async close() {}
}

class FailOnceTopicQueue extends RecordingQueue {
  private failed = false;

  override async enqueue(data: DiscoveryJobData) {
    if (!this.failed) {
      this.failed = true;
      throw new Error('Redis unavailable');
    }
    await super.enqueue(data);
  }
}

class RecordingTrendQueue implements TrendQueue {
  jobs: Array<Extract<TrendJobData, { trigger: 'manual' }>> = [];

  async enqueue(data: Extract<TrendJobData, { trigger: 'manual' }>) {
    this.jobs.push(data);
  }

  async close() {}
}

class FailOnceTrendQueue extends RecordingTrendQueue {
  private failed = false;

  override async enqueue(data: Extract<TrendJobData, { trigger: 'manual' }>) {
    if (!this.failed) {
      this.failed = true;
      throw new Error('Redis unavailable');
    }
    await super.enqueue(data);
  }
}

class RecordingCreatorQueue implements CreatorQueue {
  jobs: CreatorJobData[] = [];

  async enqueue(data: CreatorJobData) {
    this.jobs.push(data);
  }

  async close() {}
}

class FailOnceCreatorQueue extends RecordingCreatorQueue {
  private failed = false;

  override async enqueue(data: CreatorJobData) {
    if (!this.failed) {
      this.failed = true;
      throw new Error('Redis unavailable');
    }
    await super.enqueue(data);
  }
}

describe('AI discovery API', () => {
  let app: INestApplication;
  let store: MemoryTopicStore;
  let queue: RecordingQueue;
  let trendQueue: RecordingTrendQueue;
  let creatorQueue: RecordingCreatorQueue;
  let creatorResolution: CreatorResolutionService;
  let personalizationFacts: MemoryPersonalizationFacts;
  const discoverySources: DiscoverySourceStatus[] = [
    { id: 'openrouter-search', label: 'OpenRouter Web Search', category: 'web', status: 'enabled' },
    { id: 'twitterapi-io', label: 'X', category: 'social', status: 'not_configured' },
  ];

  beforeEach(async () => {
    store = new MemoryTopicStore();
    queue = new RecordingQueue();
    trendQueue = new RecordingTrendQueue();
    creatorQueue = new RecordingCreatorQueue();
    personalizationFacts = {
      events: [{
        id: 'interest-event-1', userId: 'user-a', eventType: 'topic_state',
        sourceRef: 'topic-agents', occurredAt: '2026-07-27T08:00:00.000Z',
        recordedAt: '2026-07-27T08:00:00.000Z', supersededAt: null,
        payload: {
          schemaVersion: 1, state: 'active', topicId: 'topic-agents',
          keyword: 'Agents', normalizedKeyword: 'agents',
        },
      }],
      tags: [{
        tagId: 'tag-agents', slug: 'agents', displayName: 'Agents', kind: 'topic',
        confidence: 1, contentKey: 'topic://agents',
        createdAt: '2026-07-27T08:00:00.000Z',
      }],
      creatorContent: [], settings: {}, forgottenTagIds: {},
    };
    const rssResolver: CreatorIdentityResolver = {
      platform: 'rss',
      label: 'RSS/Atom',
      status: 'enabled',
      supports: (input) => input.startsWith('https://'),
      resolve: async (input) => [{
        platform: 'rss',
        accountKey: input,
        resolutionInput: input,
        displayName: 'Example Engineering',
        handle: 'Example Team',
        avatarUrl: 'https://example.com/avatar.png',
        bio: 'Engineering updates',
        verified: null,
        profileUrl: 'https://example.com/',
        feedUrl: input,
      }],
    };
    creatorResolution = new CreatorResolutionService(
      [rssResolver],
      'test-creator-resolution-secret',
      () => new Date('2026-07-27T12:00:00.000Z'),
    );
    app = await createApiApp({
      store,
      queue,
      trendQueue,
      creatorQueue,
      creatorResolution,
      aiConfigured: true,
      discoverySources,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
      personalizationMemory: new MemoryPersonalizationMemory(
        () => personalizationFacts,
        () => new Date('2026-07-27T12:00:00.000Z'),
      ),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns one validated trace ID in both headers and error bodies', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/interests')
      .set('x-trace-id', 'trace-request-1')
      .expect(401);
    expect(response.headers['x-trace-id']).toBe('trace-request-1');
    expect(response.body.traceId).toBe('trace-request-1');

    const unsafe = await request(app.getHttpServer())
      .get('/api/v1/interests')
      .set('x-trace-id', 'student@example.com secret')
      .expect(401);
    expect(unsafe.headers['x-trace-id']).toEqual(expect.any(String));
    expect(unsafe.headers['x-trace-id']).not.toBe('student@example.com secret');
    expect(unsafe.body.traceId).toBe(unsafe.headers['x-trace-id']);
  });

  it('reads and controls only the authenticated user interest memory', async () => {
    const initial = await request(app.getHttpServer())
      .get('/api/v1/interests')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(initial.body).toMatchObject({
      personalizationEnabled: true,
      longTerm: [{ id: 'tag-agents', name: 'Agents', sources: ['keyword'] }],
    });
    expect(initial.body.longTerm[0]).not.toHaveProperty('score');

    const paused = await request(app.getHttpServer())
      .put('/api/v1/interests/settings')
      .set('x-user-id', 'user-a')
      .send({ personalizationEnabled: false })
      .expect(200);
    expect(paused.body.personalizationEnabled).toBe(false);

    const forgotten = await request(app.getHttpServer())
      .delete('/api/v1/interests/tag-agents')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(forgotten.body.longTerm).toEqual([]);
    expect(personalizationFacts.forgottenTagIds['user-b']).toBeUndefined();

    await request(app.getHttpServer())
      .delete('/api/v1/interests')
      .set('x-user-id', 'user-a')
      .expect(200);
    await request(app.getHttpServer()).get('/api/v1/interests').expect(401);
  });

  it('updates owned digest settings and previews at most ten non-exploration items', async () => {
    const initial = await request(app.getHttpServer())
      .get('/api/v1/digest-preference')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(initial.body).toEqual({
      enabled: false, localTime: '08:00', timezone: 'Asia/Shanghai',
    });
    expect(initial.body).not.toHaveProperty('recipientEmail');
    await request(app.getHttpServer())
      .get('/api/v1/digest-status')
      .set('x-user-id', 'user-a')
      .expect(200, {
        deliveryCapability: 'not_configured', nextLocalSend: null, recentRun: null,
      });

    const updated = await request(app.getHttpServer())
      .put('/api/v1/digest-preference')
      .set('x-user-id', 'user-a')
      .send({ enabled: true, localTime: '09:30', timezone: 'Asia/Tokyo' })
      .expect(200);
    expect(updated.body).toEqual({
      enabled: true, localTime: '09:30', timezone: 'Asia/Tokyo',
    });
    await request(app.getHttpServer())
      .put('/api/v1/digest-preference')
      .set('x-user-id', 'user-a')
      .send({ enabled: true, localTime: '24:00', timezone: 'Asia/Tokyo' })
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/v1/digest-preference')
      .set('x-user-id', 'user-a')
      .send({ enabled: true, localTime: '09:30', timezone: 'Tokyo' })
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/v1/digest-preference')
      .set('x-user-id', 'user-a')
      .send({
        enabled: true, localTime: '09:30', timezone: 'Asia/Tokyo',
        recipientEmail: 'other@example.com',
      })
      .expect(400);

    const userB = await request(app.getHttpServer())
      .get('/api/v1/digest-preference')
      .set('x-user-id', 'user-b')
      .expect(200);
    expect(userB.body.enabled).toBe(false);

    const items = Array.from({ length: 12 }, (_, index) => store.seedRadarItem(
      'user-a',
      'quality',
      {
        sourceUrl: `https://example.com/digest-${index}`,
        discoveredAt: `2026-07-27T${String(index).padStart(2, '0')}:00:00.000Z`,
      },
    ));
    personalizationFacts.tags.push({
      tagId: 'tag-edge', slug: 'edge', displayName: 'Edge', kind: 'topic',
      confidence: 0.9, contentKey: items[0]!.contentKey,
      createdAt: '2026-07-27T08:00:00.000Z',
    });
    personalizationFacts.adjacencies = [{
      leftTagId: 'tag-agents', rightTagId: 'tag-edge',
      relationVersion: 'qualified-content-cooccurrence-v1',
    }];
    store.seedRadarItem('user-b', 'quality', {
      sourceUrl: 'https://example.com/user-b-only',
    });

    const preview = await request(app.getHttpServer())
      .get('/api/v1/digest-preview')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(preview.body.items).toHaveLength(10);
    expect(preview.body.items.some((item: { contentKey: string }) => (
      item.contentKey === items[0]!.contentKey
    ))).toBe(false);
    expect(preview.body.items.every((item: Record<string, unknown>) => (
      !('score' in item) && !('isExploration' in item) && !('tagId' in item)
    ))).toBe(true);

    const userBPreview = await request(app.getHttpServer())
      .get('/api/v1/digest-preview')
      .set('x-user-id', 'user-b')
      .expect(200);
    expect(userBPreview.body.items).toHaveLength(1);
    expect(userBPreview.body.items[0].contentKey).toBe('https://example.com/user-b-only');
    await request(app.getHttpServer()).get('/api/v1/digest-preview').expect(401);
    await request(app.getHttpServer()).get('/api/v1/digest-status').expect(401);
  });

  it('creates one trimmed keyword topic and enqueues its first refresh', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('x-user-id', 'user-a')
      .send({ keyword: '  AI Agent  ' })
      .expect(201);

    expect(response.body).toMatchObject({
      userId: 'user-a',
      keyword: 'AI Agent',
      runStatus: 'queued',
      expandedTerms: [],
      lastRun: { trigger: 'initial', status: 'queued', newItemCount: null },
    });
    expect(queue.jobs).toEqual([{
      topicId: response.body.id,
      userId: 'user-a',
      trigger: 'initial',
    }]);
  });

  it('manages an owned RSS creator subscription and enqueues synchronization', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/creators')
      .set('x-user-id', 'user-a')
      .send({ url: 'https://Example.com/feed.xml?utm_source=test' })
      .expect(202);

    expect(created.body).toMatchObject({
      userId: 'user-a',
      platform: 'rss',
      displayName: 'example.com',
      feedUrl: 'https://example.com/feed.xml',
      runStatus: 'queued',
    });
    expect(creatorQueue.jobs).toEqual([{
      creatorId: created.body.id,
      userId: 'user-a',
      trigger: 'manual',
    }]);

    await request(app.getHttpServer())
      .post('/api/v1/creators')
      .set('x-user-id', 'user-a')
      .send({ url: 'https://example.com/feed.xml' })
      .expect(409);
    await request(app.getHttpServer())
      .get('/api/v1/creators')
      .set('x-user-id', 'user-b')
      .expect(200, []);

    await request(app.getHttpServer())
      .patch(`/api/v1/creators/${created.body.id}`)
      .set('x-user-id', 'user-a')
      .send({ paused: true })
      .expect(200)
      .expect(({ body }) => expect(body.pausedAt).not.toBeNull());
    await request(app.getHttpServer())
      .post(`/api/v1/creators/${created.body.id}/refresh`)
      .set('x-user-id', 'user-a')
      .expect(409);
    await request(app.getHttpServer())
      .delete(`/api/v1/creators/${created.body.id}`)
      .set('x-user-id', 'user-a')
      .expect(204);
  });

  it('resolves a public creator identity before creating the confirmed subscription', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/creator-platforms')
      .set('x-user-id', 'user-a')
      .expect(200, [{ id: 'rss', label: 'RSS/Atom', status: 'enabled' }]);

    const resolution = await request(app.getHttpServer())
      .post('/api/v1/creators/resolve')
      .set('x-user-id', 'user-a')
      .send({ input: 'https://example.com/feed.xml' })
      .expect(201);

    expect(resolution.body.candidates).toEqual([expect.objectContaining({
      platform: 'rss',
      displayName: 'Example Engineering',
      handle: 'Example Team',
      profileUrl: 'https://example.com/',
      feedUrl: 'https://example.com/feed.xml',
    })]);

    const created = await request(app.getHttpServer())
      .post('/api/v1/creators')
      .set('x-user-id', 'user-a')
      .send({ resolutionTokens: [resolution.body.candidates[0].resolutionToken] })
      .expect(202);

    expect(created.body).toEqual([expect.objectContaining({
      platform: 'rss',
      displayName: 'Example Engineering',
      profileUrl: 'https://example.com/',
      feedUrl: 'https://example.com/feed.xml',
    })]);
    expect(creatorQueue.jobs).toEqual([{
      creatorId: created.body[0].id,
      userId: 'user-a',
      trigger: 'manual',
    }]);
  });

  it('returns a safe 404 for another user creator item collection', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/creators')
      .set('x-user-id', 'user-a')
      .send({ url: 'https://example.com/feed.xml' })
      .expect(202);

    await request(app.getHttpServer())
      .get(`/api/v1/creators/${created.body.id}/items`)
      .set('x-user-id', 'user-b')
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('CREATOR_NOT_FOUND'));
    await request(app.getHttpServer())
      .get(`/api/v1/creators/${created.body.id}/items`)
      .set('x-user-id', 'user-a')
      .expect(200, []);
  });

  it('compensates creator refresh registration when enqueueing fails', async () => {
    const failingCreatorQueue = new FailOnceCreatorQueue();
    const localApp = await createApiApp({
      store,
      queue,
      trendQueue,
      creatorQueue: failingCreatorQueue,
      aiConfigured: true,
      discoverySources,
    });
    const creator = await store.createCreator('user-a', {
      platform: 'rss',
      accountKey: 'https://example.com/feed.xml',
      displayName: 'Example',
      profileUrl: 'https://example.com/feed.xml',
      feedUrl: 'https://example.com/feed.xml',
    });
    await store.compensateCreatorRefresh('user-a', creator.id);

    await request(localApp.getHttpServer())
      .post(`/api/v1/creators/${creator.id}/refresh`)
      .set('x-user-id', 'user-a')
      .expect(500);
    await request(localApp.getHttpServer())
      .get('/api/v1/creators')
      .set('x-user-id', 'user-a')
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({
        id: creator.id,
        runStatus: 'failed',
        lastError: { code: 'CREATOR_QUEUE_UNAVAILABLE' },
      }));

    await localApp.close();
  });

  it('compensates creator resume when enqueueing fails', async () => {
    const failingCreatorQueue = new FailOnceCreatorQueue();
    const localApp = await createApiApp({
      store,
      queue,
      trendQueue,
      creatorQueue: failingCreatorQueue,
      aiConfigured: true,
      discoverySources,
    });
    const creator = await store.createCreator('user-a', {
      platform: 'rss',
      accountKey: 'https://example.com/feed.xml',
      displayName: 'Example',
      profileUrl: 'https://example.com/feed.xml',
      feedUrl: 'https://example.com/feed.xml',
    });
    await store.updateCreator('user-a', creator.id, { paused: true });

    await request(localApp.getHttpServer())
      .patch(`/api/v1/creators/${creator.id}`)
      .set('x-user-id', 'user-a')
      .send({ paused: false })
      .expect(500);
    await request(localApp.getHttpServer())
      .get('/api/v1/creators')
      .set('x-user-id', 'user-a')
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({
        id: creator.id,
        pausedAt: null,
        runStatus: 'failed',
        lastError: { code: 'CREATOR_QUEUE_UNAVAILABLE' },
      }));

    await localApp.close();
  });

  it('exposes liveness and dependency readiness without secrets', async () => {
    const localApp = await createApiApp({
      store,
      queue,
      trendQueue,
      creatorQueue,
      aiConfigured: false,
      healthChecks: {
        database: { check: async () => {} },
        redis: { check: async () => { throw new Error('redis://secret'); } },
      },
    });

    await request(localApp.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'ok' }));
    await request(localApp.getHttpServer())
      .get('/metrics')
      .expect(200)
      .expect('Content-Type', /text\/plain/)
      .expect(({ text }) => {
        expect(text).toContain('lettermate_api_http_requests_total');
        expect(text).toContain('route="/api/v1/health"');
        expect(text).not.toContain('user-a');
      });
    await request(localApp.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503)
      .expect(({ body }) => {
        expect(body).toEqual(expect.objectContaining({
          status: 'degraded',
          dependencies: {
            database: { status: 'ok' },
            redis: { status: 'error', code: 'REDIS_UNAVAILABLE' },
            ai: { status: 'not_configured', code: 'AI_NOT_CONFIGURED' },
          },
        }));
        expect(JSON.stringify(body)).not.toContain('secret');
      });

    await localApp.close();

    const healthyApp = await createApiApp({
      store,
      queue,
      trendQueue,
      creatorQueue,
      aiConfigured: true,
      healthChecks: {
        database: { check: async () => {} },
        redis: { check: async () => {} },
      },
    });
    await request(healthyApp.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'ok' }));
    await healthyApp.close();
  });

  it('rejects equivalent duplicate keywords for one user', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('x-user-id', 'user-a')
      .send({ keyword: 'ＡＩ Agent' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('x-user-id', 'user-a')
      .send({ keyword: 'ai agent' })
      .expect(409);

    expect(response.body.code).toBe('TOPIC_ALREADY_EXISTS');
  });

  it('rejects create and refresh without an OpenRouter Key', async () => {
    const localStore = new MemoryTopicStore();
    const topic = localStore.seedTopic('user-a', 'AI Agent');
    const localQueue = new RecordingQueue();
    const noKeyApp = await createApiApp({
      store: localStore,
      queue: localQueue,
      trendQueue: new RecordingTrendQueue(),
      creatorQueue: new RecordingCreatorQueue(),
      aiConfigured: false,
    });

    await request(noKeyApp.getHttpServer())
      .post('/api/v1/topics')
      .set('x-user-id', 'user-a')
      .send({ keyword: 'TypeScript' })
      .expect(503)
      .expect(({ body }) => expect(body.code).toBe('AI_NOT_CONFIGURED'));
    await request(noKeyApp.getHttpServer())
      .post(`/api/v1/topics/${topic.id}/refresh`)
      .set('x-user-id', 'user-a')
      .expect(503);
    expect(localQueue.jobs).toEqual([]);

    await noKeyApp.close();
  });

  it('lists and refreshes only the authenticated users topics', async () => {
    const own = store.seedTopic('user-a', 'AI');
    const other = store.seedTopic('user-b', 'Private');

    const list = await request(app.getHttpServer())
      .get('/api/v1/topics')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(list.body.map((topic: { id: string }) => topic.id)).toEqual([own.id]);

    await request(app.getHttpServer())
      .post(`/api/v1/topics/${other.id}/refresh`)
      .set('x-user-id', 'user-a')
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/topics/${own.id}/refresh`)
      .set('x-user-id', 'user-a')
      .expect(202)
      .expect(({ body }) => expect(body).toMatchObject({
        runStatus: 'queued', lastRun: null,
      }));
    expect(queue.jobs).toContainEqual({
      topicId: own.id,
      userId: 'user-a',
      trigger: 'manual',
    });
  });

  it('pauses and resumes only an owned keyword monitor while retaining history', async () => {
    const own = store.seedTopic('user-a', 'AI Agent');
    const other = store.seedTopic('user-b', 'Private');
    store.seedItem(own.id, 'quality');

    await request(app.getHttpServer())
      .post(`/api/v1/topics/${other.id}/pause`)
      .set('x-user-id', 'user-a')
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/v1/topics/${own.id}/pause`)
      .set('x-user-id', 'user-a')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: own.id,
        pausedAt: expect.any(String),
        nextRunAt: null,
      }));

    await request(app.getHttpServer())
      .post(`/api/v1/topics/${own.id}/refresh`)
      .set('x-user-id', 'user-a')
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('TOPIC_PAUSED'));
    expect(queue.jobs).toEqual([]);

    await request(app.getHttpServer())
      .get('/api/v1/feed?range=all')
      .set('x-user-id', 'user-a')
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({ topicKeywordActive: true }));

    await request(app.getHttpServer())
      .post(`/api/v1/topics/${own.id}/resume`)
      .set('x-user-id', 'user-a')
      .expect(202)
      .expect(({ body }) => expect(body).toMatchObject({
        id: own.id,
        pausedAt: null,
        runStatus: 'queued',
      }));
    expect(queue.jobs).toEqual([{
      topicId: own.id,
      userId: 'user-a',
      trigger: 'manual',
    }]);
  });

  it('updates an owned keyword monitor and enqueues discovery', async () => {
    const topic = store.seedTopic('user-a', 'gpt-5.7');

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/topics/${topic.id}`)
      .set('x-user-id', 'user-a')
      .send({ keyword: 'gpt-5.8' })
      .expect(200);

    expect(response.body).toMatchObject({ keyword: 'gpt-5.8', expandedTerms: [] });
    expect(queue.jobs).toContainEqual({ topicId: topic.id, userId: 'user-a', trigger: 'manual' });
  });

  it('compensates a failed update enqueue so the topic can be refreshed again', async () => {
    const failingQueue = new FailOnceTopicQueue();
    const localApp = await createApiApp({
      store, queue: failingQueue, trendQueue, creatorQueue, aiConfigured: true, discoverySources,
    });
    const topic = store.seedTopic('user-a', 'gpt-5.7');

    await request(localApp.getHttpServer()).patch(`/api/v1/topics/${topic.id}`)
      .set('x-user-id', 'user-a')
      .send({ keyword: 'gpt-5.8', expandedTerms: [] })
      .expect(500);
    await request(localApp.getHttpServer()).get('/api/v1/topics')
      .set('x-user-id', 'user-a')
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({
        runStatus: 'failed',
        lastError: {
          code: 'TOPIC_QUEUE_UNAVAILABLE',
          message: '发现任务暂时无法入队，请稍后重试',
        },
      }));
    await request(localApp.getHttpServer()).post(`/api/v1/topics/${topic.id}/refresh`)
      .set('x-user-id', 'user-a')
      .expect(202);
    expect(failingQueue.jobs).toContainEqual({
      topicId: topic.id, userId: 'user-a', trigger: 'manual',
    });
    await localApp.close();
  });

  it('soft deletes owned topics while retaining historical feed items', async () => {
    const topic = store.seedTopic('user-a', 'gpt-5.7');
    const item = store.seedItem(topic.id, 'quality');

    await request(app.getHttpServer())
      .delete(`/api/v1/topics/${topic.id}`)
      .set('x-user-id', 'user-a')
      .expect(204);

    await request(app.getHttpServer()).get('/api/v1/topics').set('x-user-id', 'user-a')
      .expect(200, []);
    await request(app.getHttpServer()).get(`/api/v1/items/${item.id}`).set('x-user-id', 'user-a')
      .expect(200).expect(({ body }) => expect(body).toMatchObject({ topicKeywordActive: false }));
  });

  it('returns Topic keyword snapshots and lifecycle state in Feed responses', async () => {
    const topic = store.seedTopic('user-a', 'AI Agent');
    store.seedItem(topic.id, 'quality');

    const active = await request(app.getHttpServer())
      .get('/api/v1/feed?range=all')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(active.body[0]).toMatchObject({
      origin: 'topic',
      topicKeyword: 'AI Agent',
      topicKeywordActive: true,
    });

    await request(app.getHttpServer())
      .patch(`/api/v1/topics/${topic.id}`)
      .set('x-user-id', 'user-a')
      .send({ keyword: 'Agent Framework', expandedTerms: [] })
      .expect(200);
    const renamed = await request(app.getHttpServer())
      .get('/api/v1/feed?range=all')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(renamed.body[0]).toMatchObject({
      topicKeyword: 'AI Agent',
      topicKeywordActive: false,
    });

    await request(app.getHttpServer())
      .delete(`/api/v1/topics/${topic.id}`)
      .set('x-user-id', 'user-a')
      .expect(204);
    const deleted = await request(app.getHttpServer())
      .get('/api/v1/feed?range=all')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(deleted.body[0]).toMatchObject({
      topicKeyword: 'AI Agent',
      topicKeywordActive: false,
    });
  });

  it('hides topic update and deletion across ownership boundaries', async () => {
    const topic = store.seedTopic('user-b', 'Private');
    await request(app.getHttpServer()).patch(`/api/v1/topics/${topic.id}`)
      .set('x-user-id', 'user-a').send({ keyword: 'Changed', expandedTerms: [] }).expect(404);
    await request(app.getHttpServer()).delete(`/api/v1/topics/${topic.id}`)
      .set('x-user-id', 'user-a').expect(404);
  });

  it('isolates feed and item details by user', async () => {
    const topic = store.seedTopic('user-b', 'Private');
    const item = store.seedItem(topic.id, 'quality');

    await request(app.getHttpServer())
      .get(`/api/v1/feed?topicId=${topic.id}`)
      .set('x-user-id', 'user-a')
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/items/${item.id}`)
      .set('x-user-id', 'user-a')
      .expect(404);
  });

  it('supports user-owned Radar detail through the unified item endpoint', async () => {
    const own = store.seedRadarItem('user-a', 'quality');
    const other = store.seedRadarItem('user-b', 'hot');

    await request(app.getHttpServer())
      .get(`/api/v1/items/${own.id}`)
      .set('x-user-id', 'user-a')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: own.id, origin: 'trend', topicId: null,
      }));
    await request(app.getHttpServer())
      .get(`/api/v1/items/${other.id}`)
      .set('x-user-id', 'user-a')
      .expect(404);
  });

  it('filters the feed by hot or quality', async () => {
    store.seedDiscovery('user-a', 'hot');
    store.seedDiscovery('user-a', 'quality');

    const response = await request(app.getHttpServer())
      .get('/api/v1/feed?kind=hot')
      .set('x-user-id', 'user-a')
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].kind).toBe('hot');
  });

  it('searches persisted owner articles with existing Feed filters', async () => {
    const topic = store.seedTopic('user-a', 'Agents');
    const otherTopic = store.seedTopic('user-b', 'Private');
    await store.completeFakeDiscovery('user-a', topic.id, {
      expandedTerms: [],
      items: [{
        kind: 'quality', title: '智能体工程实践', summary: '可复现方法', reason: '内容深入',
        sourceUrls: ['https://example.com/agent-engineering'], publishedAt: null,
        sourceType: 'web', platform: 'Example', authorName: null, authorHandle: null,
        externalId: null, provenanceKind: 'fetched_page',
      }, {
        kind: 'hot', title: '智能体工程热点', summary: '近期讨论', reason: '热度上升',
        sourceUrls: ['https://example.com/agent-hot'], publishedAt: null,
        sourceType: 'web', platform: 'Example', authorName: null, authorHandle: null,
        externalId: null, provenanceKind: 'fetched_page',
      }, {
        kind: 'quality', title: '无关文章', summary: '普通内容', reason: '普通理由',
        sourceUrls: ['https://example.com/unmatched'], publishedAt: null,
        sourceType: 'web', platform: 'Example', authorName: null, authorHandle: null,
        externalId: null, provenanceKind: 'fetched_page',
      }],
    });
    await store.completeFakeDiscovery('user-b', otherTopic.id, {
      expandedTerms: [],
      items: [{
        kind: 'quality', title: '智能体工程私有文章', summary: '私有', reason: '私有',
        sourceUrls: ['https://example.com/private'], publishedAt: null,
        sourceType: 'web', platform: 'Example', authorName: null, authorHandle: null,
        externalId: null, provenanceKind: 'fetched_page',
      }],
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/feed?q=${encodeURIComponent(' 工程 ')}&origin=topic&kind=quality&range=all&topicId=${topic.id}`)
      .set('x-user-id', 'user-a')
      .expect(200);

    expect(response.body.map((item: { title: string }) => item.title))
      .toEqual(['智能体工程实践']);
  });

  it('rejects persisted Feed search queries over 100 characters', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/feed?q=${'x'.repeat(101)}`)
      .set('x-user-id', 'user-a')
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('defaults the feed to 30 days and supports all retained history', async () => {
    const topic = store.seedTopic('user-a', 'History');
    store.seedItem(topic.id, 'quality', {
      publishedAt: '2020-01-01T00:00:00.000Z',
      discoveredAt: '2020-01-02T00:00:00.000Z',
    });
    store.seedItem(topic.id, 'quality', {
      publishedAt: '2026-06-01T00:00:00.000Z',
      discoveredAt: '2026-06-01T01:00:00.000Z',
    });
    store.seedItem(topic.id, 'hot', {
      publishedAt: '2026-07-26T00:00:00.000Z',
      discoveredAt: '2026-07-26T01:00:00.000Z',
    });

    const recent = await request(app.getHttpServer())
      .get('/api/v1/feed')
      .set('x-user-id', 'user-a')
      .expect(200);
    const all = await request(app.getHttpServer())
      .get('/api/v1/feed?range=all')
      .set('x-user-id', 'user-a')
      .expect(200);

    expect(recent.body).toHaveLength(1);
    expect(recent.body[0].kind).toBe('hot');
    expect(all.body).toHaveLength(3);
  });

  it('applies a 72-hour Feed window from the injected clock', async () => {
    const topic = store.seedTopic('user-a', 'Window');
    store.seedItem(topic.id, 'quality', {
      publishedAt: '2026-07-24T11:59:59.999Z',
    });
    const boundary = store.seedItem(topic.id, 'hot', {
      publishedAt: '2026-07-24T12:00:00.000Z',
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/feed?range=3d')
      .set('x-user-id', 'user-a')
      .expect(200);

    expect(response.body.map((item: { id: string }) => item.id)).toEqual([boundary.id]);
  });

  it('filters the unified Feed by Topic or trend origin', async () => {
    const topic = store.seedTopic('user-a', 'Origins');
    const topicItem = store.seedItem(topic.id, 'quality', {
      publishedAt: '2026-07-27T10:00:00.000Z',
    });
    const radarItem = store.seedRadarItem('user-a', 'hot', {
      publishedAt: '2026-07-27T11:00:00.000Z',
    });

    const trend = await request(app.getHttpServer())
      .get('/api/v1/feed?origin=trend')
      .set('x-user-id', 'user-a')
      .expect(200);
    const topicOnly = await request(app.getHttpServer())
      .get('/api/v1/feed?origin=topic')
      .set('x-user-id', 'user-a')
      .expect(200);

    expect(trend.body.map((item: { id: string }) => item.id)).toEqual([radarItem.id]);
    expect(topicOnly.body.map((item: { id: string }) => item.id)).toEqual([topicItem.id]);
  });

  it('sets, switches, clears, and safely scopes persisted Feed feedback', async () => {
    const own = store.seedRadarItem('user-a', 'quality', {
      sourceUrl: 'https://example.com/articles/feedback?utm_source=test',
    });
    const other = store.seedRadarItem('user-b', 'quality', {
      sourceUrl: 'https://example.com/articles/private',
    });
    const path = `/api/v1/feedback/${encodeURIComponent(own.contentKey)}`;

    await request(app.getHttpServer()).put(path).set('x-user-id', 'user-a')
      .send({ value: 'interested' }).expect(200)
      .expect({ contentKey: own.contentKey, value: 'interested' });
    await request(app.getHttpServer()).put(path).set('x-user-id', 'user-a')
      .send({ value: 'interested' }).expect(200);
    await request(app.getHttpServer()).get('/api/v1/feed?range=all')
      .set('x-user-id', 'user-a').expect(200)
      .expect(({ body }) => expect(body[0].feedback).toBe('interested'));

    await request(app.getHttpServer()).put(path).set('x-user-id', 'user-a')
      .send({ value: 'less' }).expect(200)
      .expect({ contentKey: own.contentKey, value: 'less' });
    await request(app.getHttpServer()).put(path).set('x-user-id', 'user-a')
      .send({ value: null }).expect(200)
      .expect({ contentKey: own.contentKey, value: null });
    await request(app.getHttpServer()).get(`/api/v1/items/${own.id}`)
      .set('x-user-id', 'user-a').expect(200)
      .expect(({ body }) => expect(body.feedback).toBeNull());

    await request(app.getHttpServer())
      .put(`/api/v1/feedback/${encodeURIComponent(other.contentKey)}`)
      .set('x-user-id', 'user-a').send({ value: 'interested' }).expect(404);
    await request(app.getHttpServer())
      .put(`/api/v1/feedback/${encodeURIComponent('https://example.com/unknown')}`)
      .set('x-user-id', 'user-a').send({ value: 'interested' }).expect(404);
    await request(app.getHttpServer()).put(path).set('x-user-id', 'user-a')
      .send({ value: 'like' }).expect(400)
      .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
  });

  it('returns safe trend status and registers only one repeated manual refresh', async () => {
    const initial = await request(app.getHttpServer())
      .get('/api/v1/trends/status')
      .set('x-user-id', 'user-a')
      .expect(200);
    expect(initial.body).toEqual({
      runStatus: 'queued', nextRunAt: '2026-07-27T12:00:00.000Z',
      intervalHours: 4, lastError: null, lastRun: null,
    });

    const first = await request(app.getHttpServer())
      .post('/api/v1/trends/refresh')
      .set('x-user-id', 'user-a')
      .expect(202);
    const second = await request(app.getHttpServer())
      .post('/api/v1/trends/refresh')
      .set('x-user-id', 'user-a')
      .expect(202);

    expect(first.body).toMatchObject({
      runStatus: 'queued',
      lastRun: { trigger: 'manual', status: 'queued', newItemCount: null },
    });
    expect(second.body.lastRun).toEqual(first.body.lastRun);
    expect(trendQueue.jobs).toEqual([{
      userId: 'user-a', trigger: 'manual', runId: first.body.lastRun.id,
    }]);
    expect(JSON.stringify(first.body)).not.toMatch(/secret|token|connector|candidate/i);
  });

  it('compensates a rejected trend enqueue so the next refresh can retry', async () => {
    const localStore = new MemoryTopicStore();
    const localTrendQueue = new FailOnceTrendQueue();
    const localApp = await createApiApp({
      store: localStore,
      queue: new RecordingQueue(),
      trendQueue: localTrendQueue,
      creatorQueue: new RecordingCreatorQueue(),
      aiConfigured: true,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });

    await request(localApp.getHttpServer())
      .post('/api/v1/trends/refresh')
      .set('x-user-id', 'user-a')
      .expect(500);
    await request(localApp.getHttpServer())
      .post('/api/v1/trends/refresh')
      .set('x-user-id', 'user-a')
      .expect(202)
      .expect(({ body }) => expect(body.lastRun).toMatchObject({
        trigger: 'manual', status: 'queued',
      }));

    expect(localTrendQueue.jobs).toEqual([
      expect.objectContaining({ userId: 'user-a', trigger: 'manual', runId: expect.any(String) }),
    ]);
    await localApp.close();
  });

  it('returns safe source configuration states without credentials', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/discovery-sources')
      .set('x-user-id', 'user-a')
      .expect(200);

    expect(response.body).toEqual(discoverySources);
    expect(JSON.stringify(response.body)).not.toMatch(/key|secret|token/i);
  });

  it('derives source states from safe server configuration only', () => {
    const statuses = configuredDiscoverySources(parseConfig({
      AI_API_KEY: 'openrouter-secret',
      TWITTERAPI_IO_API_KEY: 'twitter-secret',
      DISCOVERY_RSS_FEED_URLS: 'https://example.com/feed.xml',
    }));

    expect(statuses.map(({ id }) => id)).toEqual([
      'openrouter-search',
      'twitterapi-io',
      'rss',
      'hacker-news',
      'stack-overflow',
      'arxiv',
      'github',
      'search-brave',
      'search-tavily',
      'search-bing',
      'youtube',
      'reddit',
      'bluesky',
      'bilibili',
      'twitter-trends',
      'hacker-news-trends',
      'youtube-trends',
      'reddit-trends',
      'bilibili-trends',
      'google-trends-rss',
    ]);
    expect(statuses.map(({ id }) => id)).not.toContain('x-trends');
    expect(statuses.map(({ id }) => id)).not.toContain('google-trends');

    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'twitterapi-io', status: 'enabled' }),
      expect.objectContaining({ id: 'rss', status: 'enabled' }),
      expect.objectContaining({ id: 'youtube', status: 'not_configured' }),
    ]));
    expect(JSON.stringify(statuses)).not.toMatch(/openrouter-secret|twitter-secret/);
  });

  it('rejects an invalid feed range', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/feed?range=forever')
      .set('x-user-id', 'user-a')
      .expect(400);
  });

  it('rejects invalid Feed origins and trend origin combined with topicId', async () => {
    const topic = store.seedTopic('user-a', 'Invalid combination');
    for (const path of [
      '/api/v1/feed?origin=unknown',
      `/api/v1/feed?origin=trend&topicId=${topic.id}`,
    ]) {
      await request(app.getHttpServer())
        .get(path)
        .set('x-user-id', 'user-a')
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('VALIDATION_ERROR'));
    }
  });

  it('returns a trace id for invalid keyword input', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('x-user-id', 'user-a')
      .send({ keyword: '' })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(response.body.traceId).toEqual(expect.any(String));
  });
});

describe('production session identity', () => {
  it('keeps login rate limits isolated by forwarded client IP behind one trusted proxy', async () => {
    const auth = new AuthService(
      new MemoryAuthStore(),
      'session-secret-with-at-least-32-characters',
      'csrf-secret-with-at-least-32-characters',
      () => new Date('2026-08-08T00:00:00.000Z'),
      new MemoryAuthRateLimiter(1, 60_000),
    );
    await auth.register({
      email: 'student@example.com',
      password: 'correct horse battery staple',
      timezone: 'Asia/Shanghai',
    });
    const localApp = await createApiApp({
      store: new MemoryTopicStore(),
      queue: new RecordingQueue(),
      trendQueue: new RecordingTrendQueue(),
      creatorQueue: new RecordingCreatorQueue(),
      authService: auth,
      allowDevIdentity: false,
      trustProxy: 1,
    });

    await request(localApp.getHttpServer())
      .post('/api/v1/auth/login')
      .set('x-forwarded-for', '203.0.113.10')
      .send({ email: 'student@example.com', password: 'wrong password' })
      .expect(401);
    await request(localApp.getHttpServer())
      .post('/api/v1/auth/login')
      .set('x-forwarded-for', '203.0.113.11')
      .send({ email: 'student@example.com', password: 'correct horse battery staple' })
      .expect(201);

    await localApp.close();
  });

  it('rejects spoofed identity, enforces CSRF, and revokes logout sessions', async () => {
    let currentTime = new Date('2026-08-08T00:00:00.000Z');
    const auth = new AuthService(
      new MemoryAuthStore(),
      'session-secret-with-at-least-32-characters',
      'csrf-secret-with-at-least-32-characters',
      () => currentTime,
    );
    const localApp = await createApiApp({
      store: new MemoryTopicStore(),
      queue: new RecordingQueue(),
      trendQueue: new RecordingTrendQueue(),
      creatorQueue: new RecordingCreatorQueue(),
      aiConfigured: true,
      authService: auth,
      allowDevIdentity: false,
      now: () => currentTime,
    });
    const agent = request.agent(localApp.getHttpServer());

    await request(localApp.getHttpServer())
      .get('/api/v1/topics')
      .set('x-user-id', 'spoofed-user')
      .expect(401);
    await agent.get('/api/v1/auth/session').expect(200, {
      authenticated: false, user: null, csrfToken: null,
    });

    const registered = await agent.post('/api/v1/auth/register').send({
      email: 'student@example.com',
      password: 'correct horse battery staple',
      timezone: 'Asia/Shanghai',
    }).expect(201);
    expect(registered.body).toMatchObject({
      authenticated: true,
      user: { email: 'student@example.com', timezone: 'Asia/Shanghai' },
      csrfToken: expect.any(String),
    });
    const setCookie = registered.headers['set-cookie'];
    expect(Array.isArray(setCookie) ? setCookie.join(';') : setCookie).toMatch(/lettermate_session=.*HttpOnly/);

    await agent.post('/api/v1/topics').send({ keyword: 'gpt-5.7' }).expect(403);
    await agent.post('/api/v1/topics')
      .set('x-csrf-token', 'invalid.token')
      .send({ keyword: 'gpt-5.7' })
      .expect(403);
    await agent.post('/api/v1/topics')
      .set('x-csrf-token', registered.body.csrfToken)
      .send({ keyword: 'gpt-5.7' })
      .expect(201);

    currentTime = new Date('2026-09-02T00:00:00.000Z');
    const session = await agent.get('/api/v1/auth/session').expect(200);
    expect(session.body.user.email).toBe('student@example.com');
    const renewedCookies = session.headers['set-cookie'];
    expect(Array.isArray(renewedCookies) ? renewedCookies.join(';') : renewedCookies)
      .toMatch(/lettermate_session=.*Max-Age=2592000/);
    await agent.post('/api/v1/auth/logout')
      .set('x-csrf-token', session.body.csrfToken)
      .expect(204);
    await agent.get('/api/v1/auth/session').expect(200, {
      authenticated: false, user: null, csrfToken: null,
    });
    await agent.get('/api/v1/topics').expect(401);

    await localApp.close();
  });
});
