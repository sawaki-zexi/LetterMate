import 'reflect-metadata';
import { createApiApp } from './app.js';
import { MemoryTopicStore } from './topic-store.js';
import type { TopicQueue } from './topic-queue.js';
import type { TrendQueue } from './trend-queue.js';

const store = new MemoryTopicStore();
const queue: TopicQueue = {
  async enqueue({ topicId, userId }) {
    await store.startFakeDiscovery(userId, topicId);
    await store.completeFakeDiscovery(userId, topicId, {
      expandedTerms: ['智能体', 'agentic AI'],
      items: [{
        kind: 'quality',
        title: 'Agent 工程实践指南',
        summary: '文章总结了可复现的工程方法。',
        reason: '包含实现细节与原始数据。',
        sourceUrls: ['https://example.com/agent-guide'],
        publishedAt: '2026-07-24T06:30:00.000Z',
        sourceType: 'web',
        platform: 'Example',
        authorName: 'Example Author',
        authorHandle: null,
        externalId: null,
        provenanceKind: 'ai_citation',
      }],
    });
  },
  async close() {},
};

const trendQueue: TrendQueue = {
  async enqueue({ userId }) {
    await store.startFakeTrendDiscovery(userId, 4);
    await store.completeFakeTrendDiscovery(userId, 4, [{
      kind: 'hot',
      title: 'AI tooling release gains attention',
      summary: '多个一手来源记录了这次工具更新及其核心变化。',
      reason: '包含官方发布与可回溯的实现信息。',
      sourceUrls: ['https://example.com/radar/ai-tooling-release'],
      publishedAt: '2026-07-27T08:30:00.000Z',
      sourceType: 'web',
      platform: 'Example Radar',
      authorName: 'Example Team',
      authorHandle: null,
      externalId: 'radar-release-1',
      provenanceKind: 'fetched_page',
    }]);
  },
  async close() {},
};

const app = await createApiApp({ store, queue, trendQueue, aiConfigured: true });
await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
