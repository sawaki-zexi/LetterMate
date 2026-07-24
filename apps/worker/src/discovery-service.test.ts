import type {
  DiscoveryCandidate,
  SafeError,
  Topic,
} from '@lettermate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError, type AiGateway } from './ai-gateway.js';
import {
  TopicDiscoveryService,
  type DiscoveryRepository,
} from './discovery-service.js';

const existingItem: DiscoveryCandidate = {
  kind: 'quality',
  title: 'Existing',
  summary: '旧摘要',
  reason: '旧理由',
  sourceUrls: ['https://example.com/existing'],
  publishedAt: null,
};

class FakeDiscoveryRepository implements DiscoveryRepository {
  currentTopic: Topic = {
    id: 'topic-1',
    userId: 'user-a',
    keyword: 'AI Agent',
    expandedTerms: [],
    createdAt: '2026-07-24T07:00:00.000Z',
    lastRunAt: null,
    runStatus: 'queued',
    lastError: null,
  };

  savedItems: DiscoveryCandidate[] = [];

  async findOwnedTopic(topicId: string, userId: string) {
    return this.currentTopic.id === topicId && this.currentTopic.userId === userId
      ? this.currentTopic
      : null;
  }

  async markRunning() {
    this.currentTopic = { ...this.currentTopic, runStatus: 'running', lastError: null };
  }

  async saveSuccess(
    _topicId: string,
    expandedTerms: string[],
    items: DiscoveryCandidate[],
    finishedAt: Date,
  ) {
    this.savedItems = items;
    this.currentTopic = {
      ...this.currentTopic,
      expandedTerms,
      runStatus: 'succeeded',
      lastRunAt: finishedAt.toISOString(),
      lastError: null,
    };
  }

  async saveFailure(
    _topicId: string,
    error: SafeError,
    finishedAt: Date,
    status: 'queued' | 'failed',
  ) {
    this.currentTopic = {
      ...this.currentTopic,
      runStatus: status,
      lastRunAt: finishedAt.toISOString(),
      lastError: error,
    };
  }
}

describe('TopicDiscoveryService', () => {
  it('expands, validates and saves citation-backed discoveries', async () => {
    const gateway: AiGateway = {
      expandTopic: vi.fn().mockResolvedValue({
        terms: ['智能体'],
        searchQueries: ['AI agent latest'],
      }),
      discover: vi.fn().mockResolvedValue({
        citations: ['https://example.com/post'],
        items: [
          {
            kind: 'quality',
            title: 'Deep guide',
            summary: '中文摘要',
            reason: '内容深入',
            sourceUrls: ['https://example.com/post'],
            publishedAt: null,
          },
        ],
      }),
    };
    const repository = new FakeDiscoveryRepository();

    await new TopicDiscoveryService(
      gateway,
      repository,
      () => new Date('2026-07-24T08:00:00.000Z'),
    ).run('topic-1', 'user-a');

    expect(repository.savedItems).toHaveLength(1);
    expect(repository.currentTopic).toMatchObject({
      expandedTerms: ['智能体', 'AI agent latest'],
      runStatus: 'succeeded',
      lastError: null,
    });
    expect(gateway.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: 'AI Agent',
        expandedTerms: ['智能体', 'AI agent latest'],
        lookbackDays: 7,
      }),
    );
  });

  it('does nothing when the topic does not belong to the job user', async () => {
    const gateway: AiGateway = {
      expandTopic: vi.fn(),
      discover: vi.fn(),
    };

    await new TopicDiscoveryService(gateway, new FakeDiscoveryRepository()).run(
      'topic-1',
      'user-b',
    );

    expect(gateway.expandTopic).not.toHaveBeenCalled();
  });

  it('preserves previous items and records a safe gateway failure', async () => {
    const repository = new FakeDiscoveryRepository();
    repository.savedItems = [existingItem];
    const gateway: AiGateway = {
      expandTopic: vi
        .fn()
        .mockRejectedValue(new AiGatewayError('AI_AUTH_FAILED', 'OpenRouter Key 无效', false)),
      discover: vi.fn(),
    };

    await expect(
      new TopicDiscoveryService(gateway, repository).run('topic-1', 'user-a'),
    ).rejects.toMatchObject({ code: 'AI_AUTH_FAILED' });

    expect(repository.savedItems).toEqual([existingItem]);
    expect(repository.currentTopic).toMatchObject({
      runStatus: 'failed',
      lastError: { code: 'AI_AUTH_FAILED', message: 'OpenRouter Key 无效' },
    });
  });

  it('fails when model items have no matching citations', async () => {
    const repository = new FakeDiscoveryRepository();
    const gateway: AiGateway = {
      expandTopic: vi.fn().mockResolvedValue({ terms: ['agent'], searchQueries: ['agent news'] }),
      discover: vi.fn().mockResolvedValue({
        citations: [],
        items: [
          {
            kind: 'hot',
            title: 'Invented',
            summary: '中文摘要',
            reason: '热门',
            sourceUrls: ['https://invented.test/post'],
            publishedAt: null,
          },
        ],
      }),
    };

    await expect(
      new TopicDiscoveryService(gateway, repository).run('topic-1', 'user-a'),
    ).rejects.toMatchObject({ code: 'AI_CITATIONS_MISSING' });
    expect(repository.savedItems).toEqual([]);
    expect(repository.currentTopic.lastError?.code).toBe('AI_CITATIONS_MISSING');
  });
});
