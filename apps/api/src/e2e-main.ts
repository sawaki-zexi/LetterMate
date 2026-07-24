import 'reflect-metadata';
import { createApiApp } from './app.js';
import { MemoryTopicStore } from './topic-store.js';
import type { TopicQueue } from './topic-queue.js';

const store = new MemoryTopicStore();
const queue: TopicQueue = {
  async enqueue({ topicId, userId }) {
    await store.completeFakeDiscovery(userId, topicId, {
      expandedTerms: ['智能体', 'agentic AI'],
      items: [{
        kind: 'quality',
        title: 'Agent 工程实践指南',
        summary: '文章总结了可复现的工程方法。',
        reason: '包含实现细节与原始数据。',
        sourceUrls: ['https://example.com/agent-guide'],
        publishedAt: '2026-07-24T06:30:00.000Z',
      }],
    });
  },
  async close() {},
};

const app = await createApiApp({ store, queue, aiConfigured: true });
await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
