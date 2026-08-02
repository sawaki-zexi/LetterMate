import type {
  DiscoveryJobData,
  DiscoverySourceStatus,
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

describe('AI discovery API', () => {
  let app: INestApplication;
  let store: MemoryTopicStore;
  let queue: RecordingQueue;
  let trendQueue: RecordingTrendQueue;
  const discoverySources: DiscoverySourceStatus[] = [
    { id: 'openrouter-search', label: 'OpenRouter Web Search', category: 'web', status: 'enabled' },
    { id: 'twitterapi-io', label: 'X', category: 'social', status: 'not_configured' },
  ];

  beforeEach(async () => {
    store = new MemoryTopicStore();
    queue = new RecordingQueue();
    trendQueue = new RecordingTrendQueue();
    app = await createApiApp({
      store,
      queue,
      trendQueue,
      aiConfigured: true,
      discoverySources,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });
  });

  afterEach(async () => {
    await app.close();
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

  it('updates owned topic keywords and variants and enqueues discovery', async () => {
    const topic = store.seedTopic('user-a', 'gpt-5.7');

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/topics/${topic.id}`)
      .set('x-user-id', 'user-a')
      .send({ keyword: 'gpt-5.8', expandedTerms: ['gpt 5.8'] })
      .expect(200);

    expect(response.body).toMatchObject({ keyword: 'gpt-5.8', expandedTerms: ['gpt 5.8'] });
    expect(queue.jobs).toContainEqual({ topicId: topic.id, userId: 'user-a', trigger: 'manual' });
  });

  it('compensates a failed update enqueue so the topic can be refreshed again', async () => {
    const failingQueue = new FailOnceTopicQueue();
    const localApp = await createApiApp({
      store, queue: failingQueue, trendQueue, aiConfigured: true, discoverySources,
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
