import type { DiscoveryJobData } from '@lettermate/contracts';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp } from './app.js';
import { MemoryTopicStore } from './topic-store.js';
import type { TopicQueue } from './topic-queue.js';

class RecordingQueue implements TopicQueue {
  jobs: DiscoveryJobData[] = [];

  async enqueue(data: DiscoveryJobData) {
    this.jobs.push(data);
  }

  async close() {}
}

describe('AI discovery API', () => {
  let app: INestApplication;
  let store: MemoryTopicStore;
  let queue: RecordingQueue;

  beforeEach(async () => {
    store = new MemoryTopicStore();
    queue = new RecordingQueue();
    app = await createApiApp({ store, queue, aiConfigured: true });
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
    });
    expect(queue.jobs).toEqual([{ topicId: response.body.id, userId: 'user-a' }]);
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
      .expect(202);
    expect(queue.jobs).toContainEqual({ topicId: own.id, userId: 'user-a' });
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
