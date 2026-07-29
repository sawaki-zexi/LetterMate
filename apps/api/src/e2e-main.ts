import 'reflect-metadata';
import { createApiApp } from './app.js';
import { MemoryTopicStore } from './topic-store.js';
import type { TopicQueue } from './topic-queue.js';
import type { TrendQueue } from './trend-queue.js';

const store = new MemoryTopicStore();
const relativeCalendarDay = (daysAgo: number): string => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
};

const queue: TopicQueue = {
  async enqueue({ topicId, userId }) {
    await store.startFakeDiscovery(userId, topicId);
    await store.completeFakeDiscovery(userId, topicId, {
      expandedTerms: ['gpt-5.7', 'gpt 5.7', 'gpt5.7'],
      items: [
        {
          kind: 'quality',
          title: 'gpt-5.7 Agent 工程实践指南',
          summary: '文章总结了围绕 gpt-5.7 的可复现工程方法。',
          reason: '包含实现细节与原始数据。',
          sourceUrls: ['https://example.com/agent-guide'],
          publishedAt: relativeCalendarDay(0),
          sourceType: 'web',
          platform: 'Example',
          authorName: 'Example Author',
          authorHandle: null,
          externalId: null,
          provenanceKind: 'ai_citation',
        },
        {
          kind: 'hot',
          title: 'gpt-5.7 官方更新说明',
          summary: '官方更新说明记录了版本标识、发布日期和主要变化。',
          reason: '版本号与正文相符，并有可回溯的原始来源。',
          sourceUrls: ['https://example.com/gpt-5-7-release'],
          publishedAt: relativeCalendarDay(1),
          sourceType: 'web',
          platform: 'Example',
          authorName: 'Example Release Team',
          authorHandle: null,
          externalId: 'gpt-5.7-release',
          provenanceKind: 'fetched_page',
        },
      ],
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
      publishedAt: relativeCalendarDay(2),
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
