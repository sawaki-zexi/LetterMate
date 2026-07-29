import 'reflect-metadata';
import { createApiApp } from './app.js';
import { MemoryTopicStore } from './topic-store.js';
import type { TopicQueue } from './topic-queue.js';
import type { TrendQueue } from './trend-queue.js';

const store = new MemoryTopicStore();
const FAKE_WORKER_START_DELAY_MS = 25;
const FAKE_WORKER_RUN_DELAY_MS = 300;
const scheduledRuns = new Set<Promise<void>>();

const afterDelay = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const scheduleFakeWorkerRun = (
  start: () => Promise<void>,
  complete: () => Promise<void>,
): void => {
  const scheduledRun = afterDelay(FAKE_WORKER_START_DELAY_MS)
    .then(start)
    .then(() => afterDelay(FAKE_WORKER_RUN_DELAY_MS))
    .then(complete)
    .catch(() => console.error('E2E fake worker run failed'));
  scheduledRuns.add(scheduledRun);
  void scheduledRun.finally(() => scheduledRuns.delete(scheduledRun));
};

const closeScheduledRuns = async (): Promise<void> => {
  await Promise.allSettled([...scheduledRuns]);
};

const relativeCalendarDay = (daysAgo: number): string => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
};

const queue: TopicQueue = {
  async enqueue({ topicId, userId }) {
    scheduleFakeWorkerRun(
      () => store.startFakeDiscovery(userId, topicId),
      () => store.completeFakeDiscovery(userId, topicId, {
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
      }),
    );
  },
  close: closeScheduledRuns,
};

const trendQueue: TrendQueue = {
  async enqueue({ userId }) {
    scheduleFakeWorkerRun(
      () => store.startFakeTrendDiscovery(userId, 4),
      () => store.completeFakeTrendDiscovery(userId, 4, [{
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
      }]),
    );
  },
  close: closeScheduledRuns,
};

const app = await createApiApp({ store, queue, trendQueue, aiConfigured: true });
await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
