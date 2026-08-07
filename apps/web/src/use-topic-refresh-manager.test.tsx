// @vitest-environment jsdom
import type { RunSummary, Topic } from '@lettermate/contracts';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTopicRefreshManager } from './use-topic-refresh-manager.js';

function run(id: string, status: RunSummary['status'], newItemCount = 0): RunSummary {
  const startedAt = '2026-07-29T00:00:00.000Z';
  if (status === 'succeeded') {
    return { id, trigger: 'manual', status, startedAt, finishedAt: startedAt, newItemCount };
  }
  if (status === 'failed') {
    return { id, trigger: 'manual', status, startedAt, finishedAt: startedAt, newItemCount: null };
  }
  return { id, trigger: 'manual', status, startedAt, finishedAt: null, newItemCount: null };
}

function topic(id: string, keyword: string, lastRun: RunSummary | null = null): Topic {
  return {
    id,
    userId: 'user-a',
    keyword,
    expandedTerms: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    pausedAt: null,
    lastRunAt: lastRun?.startedAt ?? null,
    nextRunAt: null,
    scheduleIntervalHours: 12,
    runStatus: lastRun?.status ?? 'succeeded',
    lastError: null,
    lastRun,
  };
}

describe('useTopicRefreshManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shares one Topic poll and retains keyed results when concurrent runs finish out of order', async () => {
    const topics = [topic('topic-1', 'AI Agent'), topic('topic-2', 'TypeScript')];
    let snapshot = topics;
    const refetchTopics = vi.fn(async () => snapshot);
    const refreshTopic = vi.fn(async (topicId: string) => {
      const current = topics.find((candidate) => candidate.id === topicId)!;
      return topic(topicId, current.keyword, run(`queued-${topicId}`, 'queued'));
    });
    const { result } = renderHook(() => useTopicRefreshManager({
      topics,
      refreshTopic,
      refetchTopics,
      invalidateFeed: vi.fn(async () => undefined),
      pollIntervalMs: 1_500,
    }));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.startTopicRefresh('topic-1');
      second = result.current.startTopicRefresh('topic-2');
    });
    await act(async () => Promise.resolve());
    expect(result.current.pendingTopicIds).toEqual(['topic-1', 'topic-2']);

    snapshot = [topics[0]!, topic('topic-2', 'TypeScript', run('done-2', 'succeeded', 3))];
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(refetchTopics).toHaveBeenCalledTimes(1);
    expect(result.current.pendingTopicIds).toEqual(['topic-1']);
    expect(result.current.notifications['topic-2']).toMatchObject({
      topicId: 'topic-2',
      message: 'TypeScript：刷新完成，新增 3 条内容',
    });

    snapshot = [
      topic('topic-1', 'AI Agent', run('done-1', 'succeeded', 1)),
      topic('topic-2', 'TypeScript', run('done-2', 'succeeded', 3)),
    ];
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(refetchTopics).toHaveBeenCalledTimes(2);
    expect(result.current.pendingTopicIds).toEqual([]);
    expect(result.current.notifications['topic-1']?.message).toBe('AI Agent：刷新完成，新增 1 条内容');
    expect(result.current.notifications['topic-2']?.message).toBe('TypeScript：刷新完成，新增 3 条内容');
    await expect(first).resolves.toMatchObject({ topicId: 'topic-1' });
    await expect(second).resolves.toMatchObject({ topicId: 'topic-2' });
  });

  it('does not start a duplicate or stale Topic target', async () => {
    const existing = topic('topic-1', 'AI Agent');
    const refreshTopic = vi.fn(async () => existing);
    const { result } = renderHook(() => useTopicRefreshManager({
      topics: [existing],
      refreshTopic,
      refetchTopics: vi.fn(async () => [existing]),
      invalidateFeed: vi.fn(async () => undefined),
    }));

    let first!: Promise<unknown>;
    act(() => { first = result.current.startTopicRefresh('topic-1'); });
    const duplicate = result.current.startTopicRefresh('topic-1');
    const stale = await result.current.startTopicRefresh('missing');

    expect(duplicate).toBe(first);
    expect(stale).toBeNull();
    expect(refreshTopic).toHaveBeenCalledTimes(1);
  });

  it('accepts a queued registration when that same Topic run becomes terminal', async () => {
    const existing = topic('topic-1', 'AI Agent');
    let snapshot = [existing];
    const { result } = renderHook(() => useTopicRefreshManager({
      topics: [existing],
      refreshTopic: vi.fn(async () => (
        topic('topic-1', 'AI Agent', run('topic-registered', 'queued'))
      )),
      refetchTopics: vi.fn(async () => snapshot),
      invalidateFeed: vi.fn(async () => undefined),
      pollIntervalMs: 1_500,
    }));

    let completion!: Promise<unknown>;
    act(() => { completion = result.current.startTopicRefresh('topic-1'); });
    await act(async () => Promise.resolve());
    snapshot = [topic('topic-1', 'AI Agent', run('topic-registered', 'succeeded', 6))];
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    await expect(completion).resolves.toMatchObject({
      topicId: 'topic-1',
      kind: 'success',
    });
  });

  it('releases a completed Topic session when unmounted during cache synchronization', async () => {
    const existing = topic('topic-1', 'AI Agent');
    let snapshot = [existing];
    const never = new Promise<never>(() => undefined);
    const onActivityChange = vi.fn();
    const { result, unmount } = renderHook(() => useTopicRefreshManager({
      topics: [existing],
      refreshTopic: vi.fn(async () => topic('topic-1', 'AI Agent', run('queued-1', 'queued'))),
      refetchTopics: vi.fn(async () => snapshot),
      invalidateFeed: vi.fn(() => never),
      pollIntervalMs: 1_500,
      synchronizationTimeoutMs: 60_000,
      onActivityChange,
    }));

    let completion!: Promise<unknown>;
    act(() => { completion = result.current.startTopicRefresh('topic-1'); });
    await act(async () => Promise.resolve());
    snapshot = [topic('topic-1', 'AI Agent', run('done-1', 'succeeded', 1))];
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    unmount();

    await expect(completion).resolves.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(onActivityChange.mock.calls).toEqual([[true]]);
  });

  it('keeps a Topic pending and duplicate-guarded until cache synchronization succeeds', async () => {
    const existing = topic('topic-1', 'AI Agent');
    let resolveSynchronization!: () => void;
    const synchronization = new Promise<void>((resolve) => { resolveSynchronization = resolve; });
    const refreshTopic = vi.fn(async () => topic('topic-1', 'AI Agent', run('queued-1', 'queued')));
    const { result } = renderHook(() => useTopicRefreshManager({
      topics: [existing],
      refreshTopic,
      refetchTopics: vi.fn(async () => [
        topic('topic-1', 'AI Agent', run('done-1', 'succeeded', 2)),
      ]),
      invalidateFeed: vi.fn(() => synchronization),
      pollIntervalMs: 1_500,
    }));

    let completion!: Promise<unknown>;
    act(() => { completion = result.current.startTopicRefresh('topic-1'); });
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(result.current.pendingTopicIds).toEqual(['topic-1']);
    expect(result.current.startTopicRefresh('topic-1')).toBe(completion);
    expect(refreshTopic).toHaveBeenCalledTimes(1);
    expect(result.current.notifications['topic-1']).toBeUndefined();

    await act(async () => resolveSynchronization());

    await expect(completion).resolves.toMatchObject({
      message: 'AI Agent：刷新完成，新增 2 条内容',
    });
    expect(result.current.pendingTopicIds).toEqual([]);
  });

  it('continues polling another Topic while one completion synchronizes', async () => {
    const topics = [topic('topic-1', 'AI Agent'), topic('topic-2', 'TypeScript')];
    let snapshot = [topics[0]!, topic('topic-2', 'TypeScript', run('done-2', 'succeeded', 1))];
    const refetchTopics = vi.fn(async () => snapshot);
    const never = new Promise<never>(() => undefined);
    const { result } = renderHook(() => useTopicRefreshManager({
      topics,
      refreshTopic: vi.fn(async (topicId: string) => (
        topic(topicId, topicId === 'topic-1' ? 'AI Agent' : 'TypeScript', run(`queued-${topicId}`, 'queued'))
      )),
      refetchTopics,
      invalidateFeed: vi.fn(() => never),
      pollIntervalMs: 1_500,
      synchronizationTimeoutMs: 60_000,
    }));

    act(() => {
      void result.current.startTopicRefresh('topic-1');
      void result.current.startTopicRefresh('topic-2');
    });
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(refetchTopics).toHaveBeenCalledTimes(1);
    expect(result.current.pendingTopicIds).toEqual(['topic-1', 'topic-2']);

    snapshot = [topics[0]!, topic('topic-2', 'TypeScript', run('done-2', 'succeeded', 1))];
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(refetchTopics).toHaveBeenCalledTimes(2);
  });

  it('keeps sync failure stale and locked until retry succeeds without late overwrite', async () => {
    const existing = topic('topic-1', 'AI Agent');
    let resolveOldSynchronization!: () => void;
    const oldSynchronization = new Promise<void>((resolve) => { resolveOldSynchronization = resolve; });
    const invalidateFeed = vi.fn<() => Promise<void>>()
      .mockReturnValueOnce(oldSynchronization)
      .mockResolvedValueOnce(undefined);
    const refreshTopic = vi.fn(async () => topic('topic-1', 'AI Agent', run('queued-1', 'queued')));
    const { result } = renderHook(() => useTopicRefreshManager({
      topics: [existing],
      refreshTopic,
      refetchTopics: vi.fn(async () => [
        topic('topic-1', 'AI Agent', run('done-1', 'succeeded', 2)),
      ]),
      invalidateFeed,
      pollIntervalMs: 1_500,
      synchronizationTimeoutMs: 1_000,
    }));

    let completion!: Promise<unknown>;
    act(() => { completion = result.current.startTopicRefresh('topic-1'); });
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(2_500));

    expect(result.current.pendingTopicIds).toEqual(['topic-1']);
    expect(result.current.synchronizationStaleTopicIds).toEqual(['topic-1']);
    expect(result.current.notifications['topic-1']).toMatchObject({
      kind: 'warning',
      message: 'AI Agent：刷新结果已生成，但发现内容尚未同步',
    });
    expect(result.current.startTopicRefresh('topic-1')).toBe(completion);
    expect(refreshTopic).toHaveBeenCalledTimes(1);

    let retried = false;
    await act(async () => { retried = await result.current.retrySynchronization('topic-1'); });

    expect(retried).toBe(true);
    expect(result.current.pendingTopicIds).toEqual([]);
    expect(result.current.synchronizationStaleTopicIds).toEqual([]);
    expect(result.current.notifications['topic-1']?.message).toBe('AI Agent：刷新完成，新增 2 条内容');
    await expect(completion).resolves.toMatchObject({ topicId: 'topic-1' });

    await act(async () => resolveOldSynchronization());
    expect(result.current.notifications['topic-1']?.message).toBe('AI Agent：刷新完成，新增 2 条内容');
  });
});
