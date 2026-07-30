// @vitest-environment jsdom
import type { RunSummary, Topic, TrendStatus } from '@lettermate/contracts';
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useRefreshCoordinator,
  type RefreshCoordinatorOptions,
} from './use-refresh-coordinator.js';

const requestTime = new Date('2026-07-28T12:00:00.000Z');

function run(
  id: string,
  status: 'queued' | 'running' | 'succeeded' | 'failed',
  startedAt = requestTime.toISOString(),
  newItemCount = 0,
): RunSummary {
  if (status === 'succeeded') {
    return {
      id,
      trigger: 'manual',
      status,
      startedAt,
      finishedAt: '2026-07-28T12:01:00.000Z',
      newItemCount,
    };
  }
  if (status === 'failed') {
    return {
      id,
      trigger: 'manual',
      status,
      startedAt,
      finishedAt: '2026-07-28T12:01:00.000Z',
      newItemCount: null,
    };
  }
  return {
    id,
    trigger: 'manual',
    status,
    startedAt,
    finishedAt: null,
    newItemCount: null,
  };
}

function topic(id: string, lastRun: RunSummary | null = null): Topic {
  return {
    id,
    userId: 'user-a',
    keyword: id,
    expandedTerms: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    lastRunAt: lastRun?.startedAt ?? null,
    nextRunAt: null,
    scheduleIntervalHours: 12,
    runStatus: lastRun?.status ?? 'succeeded',
    lastError: null,
    lastRun,
  };
}

function trend(lastRun: RunSummary | null = null): TrendStatus {
  return {
    runStatus: lastRun?.status ?? 'succeeded',
    nextRunAt: null,
    intervalHours: 4,
    lastError: null,
    lastRun,
  };
}

function setup(overrides: Partial<RefreshCoordinatorOptions> = {}, strict = false) {
  let topicSnapshot = overrides.topics ?? [topic('topic-1'), topic('topic-2')];
  let trendSnapshot = overrides.trendStatus ?? trend();
  const options: RefreshCoordinatorOptions = {
    topics: topicSnapshot,
    trendStatus: trendSnapshot,
    origin: 'all',
    refreshTopic: vi.fn(async (topicId: string) => (
      topicSnapshot.find((candidate) => candidate.id === topicId) ?? topic(topicId)
    )),
    refreshTrends: vi.fn(async () => trendSnapshot),
    refetchTopics: vi.fn(async () => topicSnapshot),
    refetchTrendStatus: vi.fn(async () => trendSnapshot),
    invalidateFeed: vi.fn(async () => undefined),
    now: () => requestTime,
    pollIntervalMs: 1_500,
    maxConsecutivePollFailures: 2,
    confirmationTimeoutMs: 60_000,
    synchronizationTimeoutMs: 2_000,
    ...overrides,
  };
  const wrapper = strict
    ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
    : undefined;
  const rendered = renderHook(() => useRefreshCoordinator(options), { wrapper });
  return {
    ...rendered,
    options,
    setSnapshots(topics: Topic[], status: TrendStatus) {
      topicSnapshot = topics;
      trendSnapshot = status;
    },
  };
}

function begin(result: ReturnType<typeof setup>['result']) {
  let completion!: ReturnType<typeof result.current.startRefresh>;
  act(() => {
    completion = result.current.startRefresh();
  });
  return completion;
}

describe('useRefreshCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('targets only a selected topic and exposes independent pending IDs', async () => {
    const harness = setup({ selectedTopicId: 'topic-2' });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());

    expect(harness.options.refreshTopic).toHaveBeenCalledTimes(1);
    expect(harness.options.refreshTopic).toHaveBeenCalledWith('topic-2');
    expect(harness.options.refreshTrends).not.toHaveBeenCalled();
    expect(harness.result.current).toMatchObject({
      active: true,
      targetCount: 1,
      pendingCount: 1,
      pendingTopicIds: ['topic-2'],
      trendPending: false,
    });

    harness.setSnapshots(
      [topic('topic-1'), topic('topic-2', run('topic-run', 'succeeded', undefined, 2))],
      trend(),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await expect(completion).resolves.toMatchObject({ message: '刷新完成，新增 2 条内容' });
  });

  it.each([
    ['all', ['topic-1', 'topic-2'], true],
    ['topic', ['topic-1', 'topic-2'], false],
    ['trend', [], true],
  ] as const)('targets the %s origin scope', async (origin, topicIds, includesTrend) => {
    const harness = setup({ origin });
    void begin(harness.result);
    await act(async () => Promise.resolve());

    expect(harness.options.refreshTopic).toHaveBeenCalledTimes(topicIds.length);
    for (const topicId of topicIds) {
      expect(harness.options.refreshTopic).toHaveBeenCalledWith(topicId);
    }
    expect(harness.options.refreshTrends).toHaveBeenCalledTimes(includesTrend ? 1 : 0);
    expect(harness.result.current.targetCount).toBe(topicIds.length + Number(includesTrend));
  });

  it('uses action-response baselines and ignores client clock skew', async () => {
    const clientBaseline = run('client-baseline', 'succeeded', '2026-07-28T11:59:00.000Z', 99);
    const serverBaseline = run('server-baseline', 'succeeded', '2026-07-28T12:30:00.000Z', 88);
    const harness = setup({
      topics: [topic('topic-1', clientBaseline)],
      selectedTopicId: 'topic-1',
      refreshTopic: vi.fn(async () => topic('topic-1', serverBaseline)),
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());

    harness.setSnapshots([topic('topic-1', clientBaseline)], trend());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(harness.result.current.active).toBe(true);
    expect(harness.options.invalidateFeed).not.toHaveBeenCalled();

    harness.setSnapshots([topic('topic-1', serverBaseline)], trend());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(harness.result.current.active).toBe(true);

    harness.setSnapshots([topic('topic-1', {
      ...run('scheduled', 'succeeded', '2026-07-28T13:00:00.000Z', 7),
      trigger: 'scheduled',
    })], trend());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(harness.result.current.active).toBe(true);

    harness.setSnapshots([
      topic('topic-1', run('accepted', 'succeeded', '2000-01-01T00:00:00.000Z', 3)),
    ], trend());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await expect(completion).resolves.toMatchObject({ message: '刷新完成，新增 3 条内容' });
    expect(harness.options.invalidateFeed).toHaveBeenCalledTimes(1);
  });

  it('does not accept the action-response run when its status later changes', async () => {
    const actionRun = run('action-run', 'running', '2026-07-28T12:00:00.000Z');
    const harness = setup({
      topics: [topic('topic-1')],
      selectedTopicId: 'topic-1',
      refreshTopic: vi.fn(async () => topic('topic-1', actionRun)),
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());

    harness.setSnapshots([
      topic('topic-1', run('action-run', 'succeeded', '2026-07-28T12:00:00.000Z', 9)),
    ], trend());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(harness.result.current.active).toBe(true);

    harness.setSnapshots([
      topic('topic-1', run('next-run', 'succeeded', '1999-01-01T00:00:00.000Z', 2)),
    ], trend());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await expect(completion).resolves.toMatchObject({ message: '刷新完成，新增 2 条内容' });
  });

  it('accepts a queued Topic registration when that same run becomes terminal', async () => {
    const queuedRun = run('topic-registered', 'queued');
    const harness = setup({
      topics: [topic('topic-1')],
      selectedTopicId: 'topic-1',
      refreshTopic: vi.fn(async () => topic('topic-1', queuedRun)),
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());

    harness.setSnapshots([
      topic('topic-1', run('topic-registered', 'succeeded', undefined, 4)),
    ], trend());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    await expect(completion).resolves.toMatchObject({ kind: 'success' });
  });

  it('accepts a queued Trend registration when that same run becomes terminal', async () => {
    const queuedRun = run('trend-registered', 'queued');
    const harness = setup({
      origin: 'trend',
      refreshTrends: vi.fn(async () => trend(queuedRun)),
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());

    harness.setSnapshots([], trend(run('trend-registered', 'succeeded', undefined, 5)));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    await expect(completion).resolves.toMatchObject({ kind: 'success' });
  });

  it('does not wait for unrelated trend polling for a selected Topic', async () => {
    const never = new Promise<never>(() => undefined);
    const refetchTrendStatus = vi.fn(() => never);
    const harness = setup({
      topics: [topic('topic-1')],
      selectedTopicId: 'topic-1',
      refetchTrendStatus,
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());
    harness.setSnapshots([topic('topic-1', run('topic-run', 'succeeded', undefined, 1))], trend());

    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(refetchTrendStatus).not.toHaveBeenCalled();
    await expect(completion).resolves.toMatchObject({ message: '刷新完成，新增 1 条内容' });
  });

  it('does not wait for unrelated Topic polling for a trend-only refresh', async () => {
    const never = new Promise<never>(() => undefined);
    const refetchTopics = vi.fn(() => never);
    const harness = setup({ origin: 'trend', refetchTopics });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());
    harness.setSnapshots([], trend(run('trend-run', 'succeeded', undefined, 1)));

    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(refetchTopics).not.toHaveBeenCalled();
    await expect(completion).resolves.toMatchObject({ message: '刷新完成，新增 1 条内容' });
  });

  it('processes Topic completion independently while targeted trend polling hangs', async () => {
    const never = new Promise<never>(() => undefined);
    const harness = setup({
      topics: [topic('topic-1')],
      refetchTrendStatus: vi.fn(() => never),
    });
    void begin(harness.result);
    await act(async () => Promise.resolve());
    harness.setSnapshots([topic('topic-1', run('topic-run', 'succeeded'))], trend());

    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(harness.result.current.pendingTopicIds).toEqual([]);
    expect(harness.result.current).toMatchObject({ active: true, pendingCount: 1, trendPending: true });
  });

  it.each([
    [run('topic-run', 'succeeded', undefined, 0), run('trend-run', 'succeeded', undefined, 0), '刷新完成，暂无新增内容', 'success'],
    [run('topic-run', 'succeeded', undefined, 4), run('trend-run', 'failed'), '部分更新失败，已新增 4 条内容', 'warning'],
    [run('topic-run', 'failed'), run('trend-run', 'failed'), '刷新失败，已保留现有内容', 'error'],
  ] as const)('reports authoritative completion outcomes', async (
    topicRun,
    trendRun,
    message,
    kind,
  ) => {
    const harness = setup({ topics: [topic('topic-1')] });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());
    harness.setSnapshots([topic('topic-1', topicRun)], trend(trendRun));

    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    await expect(completion).resolves.toEqual(expect.objectContaining({
      message,
      kind,
      ariaLive: 'polite',
    }));
    expect(harness.result.current.notification).toEqual(expect.objectContaining({ message }));
    expect(harness.result.current.active).toBe(false);
    expect(harness.options.invalidateFeed).toHaveBeenCalledTimes(1);
  });

  it('does not launch duplicate actions while active', async () => {
    const harness = setup({ selectedTopicId: 'topic-1' });
    const first = begin(harness.result);
    await act(async () => Promise.resolve());
    const second = harness.result.current.startRefresh();

    expect(second).toBe(first);
    expect(harness.options.refreshTopic).toHaveBeenCalledTimes(1);

    harness.setSnapshots([topic('topic-1', run('done', 'succeeded'))], trend());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await first;
  });

  it('counts trigger failures as terminal targets instead of polling forever', async () => {
    const refreshTopic = vi.fn(async () => { throw new Error('offline'); });
    const harness = setup({
      topics: [topic('topic-1')],
      origin: 'all',
      refreshTopic,
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());
    harness.setSnapshots([topic('topic-1')], trend(run('trend-run', 'succeeded', undefined, 2)));

    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await expect(completion).resolves.toMatchObject({
      message: '部分更新失败，已新增 2 条内容',
    });
    expect(harness.result.current.active).toBe(false);
  });

  it('stops safely when polling cannot confirm status', async () => {
    const harness = setup({
      selectedTopicId: 'topic-1',
      refetchTopics: vi.fn(async () => { throw new Error('offline'); }),
      refetchTrendStatus: vi.fn(async () => { throw new Error('offline'); }),
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());

    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    await expect(completion).resolves.toEqual(expect.objectContaining({
      kind: 'warning',
      message: '刷新状态无法确认，已保留现有内容',
      ariaLive: 'polite',
    }));
    expect(harness.result.current.active).toBe(false);
    expect(harness.options.invalidateFeed).not.toHaveBeenCalled();
  });

  it('remains mounted after Strict Mode effect replay', async () => {
    const harness = setup({ selectedTopicId: 'topic-1' }, true);
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());

    expect(harness.result.current.active).toBe(true);
    harness.setSnapshots([topic('topic-1', run('done', 'succeeded'))], trend());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await completion;
  });

  it('uses the confirmation deadline when a polling request never settles', async () => {
    const never = new Promise<never>(() => undefined);
    const harness = setup({
      selectedTopicId: 'topic-1',
      refetchTopics: vi.fn(() => never),
      confirmationTimeoutMs: 3_000,
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());

    await act(async () => vi.advanceTimersByTimeAsync(4_500));

    expect(harness.result.current.active).toBe(false);
    await expect(completion).resolves.toMatchObject({
      message: '刷新状态无法确认，已保留现有内容',
    });
  });

  it('polls while a trigger request is still pending', async () => {
    const never = new Promise<never>(() => undefined);
    const refetchTopics = vi.fn(async () => [topic('topic-1')]);
    const refetchTrendStatus = vi.fn(async () => trend());
    const harness = setup({
      selectedTopicId: 'topic-1',
      refreshTopic: vi.fn(() => never),
      refetchTopics,
      refetchTrendStatus,
    });
    void begin(harness.result);

    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(refetchTopics).toHaveBeenCalledTimes(1);
    expect(refetchTrendStatus).not.toHaveBeenCalled();
  });

  it('waits for Feed synchronization before reporting normal completion', async () => {
    let resolveSynchronization!: () => void;
    const invalidateFeed = vi.fn(() => new Promise<void>((resolve) => {
      resolveSynchronization = resolve;
    }));
    const harness = setup({
      topics: [topic('topic-1')],
      selectedTopicId: 'topic-1',
      invalidateFeed,
    });
    const completion = begin(harness.result);
    let settled = false;
    void completion.then(() => { settled = true; });
    await act(async () => Promise.resolve());
    harness.setSnapshots([topic('topic-1', run('first-run', 'succeeded', undefined, 2))], trend());

    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(invalidateFeed).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(harness.result.current).toMatchObject({ active: true, synchronizing: true });
    expect(harness.result.current.notification).toBeNull();

    await act(async () => resolveSynchronization());
    await expect(completion).resolves.toMatchObject({ message: '刷新完成，新增 2 条内容' });
    expect(harness.result.current).toMatchObject({
      active: false,
      synchronizing: false,
      synchronizationStale: false,
    });
  });

  it('exposes retryable stale synchronization and restores the exact outcome after retry', async () => {
    const invalidateFeed = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('cache offline'))
      .mockResolvedValueOnce(undefined);
    const harness = setup({
      topics: [topic('topic-1')],
      selectedTopicId: 'topic-1',
      invalidateFeed,
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());
    harness.setSnapshots([topic('topic-1', run('first-run', 'succeeded', undefined, 2))], trend());

    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    await expect(completion).resolves.toMatchObject({
      kind: 'warning',
      message: '刷新结果已生成，但发现内容尚未同步',
    });
    expect(harness.result.current).toMatchObject({
      active: false,
      synchronizing: false,
      synchronizationStale: true,
    });

    let retried = false;
    await act(async () => { retried = await harness.result.current.retrySynchronization(); });

    expect(retried).toBe(true);
    expect(invalidateFeed).toHaveBeenCalledTimes(2);
    expect(harness.result.current.synchronizationStale).toBe(false);
    expect(harness.result.current.notification).toMatchObject({
      kind: 'success',
      message: '刷新完成，新增 2 条内容',
    });
  });

  it('times out hanging Feed synchronization and allows another refresh', async () => {
    const never = new Promise<never>(() => undefined);
    const invalidateFeed = vi.fn(() => never);
    const harness = setup({
      topics: [topic('topic-1')],
      selectedTopicId: 'topic-1',
      invalidateFeed,
      synchronizationTimeoutMs: 2_000,
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());
    harness.setSnapshots([topic('topic-1', run('first-run', 'succeeded'))], trend());

    await act(async () => vi.advanceTimersByTimeAsync(3_500));

    expect(invalidateFeed).toHaveBeenCalledTimes(1);
    expect(harness.result.current.active).toBe(false);
    expect(harness.result.current.synchronizationStale).toBe(true);
    await expect(completion).resolves.toMatchObject({
      message: '刷新结果已生成，但发现内容尚未同步',
    });

    void begin(harness.result);
    await act(async () => Promise.resolve());
    expect(harness.options.refreshTopic).toHaveBeenCalledTimes(2);
    expect(harness.result.current.synchronizationStale).toBe(false);
    await expect(harness.result.current.retrySynchronization()).resolves.toBe(false);
  });

  it('contains synchronous polling throws and terminates safely', async () => {
    const refetchTopics = vi.fn(() => { throw new Error('sync offline'); });
    const harness = setup({
      selectedTopicId: 'topic-1',
      refetchTopics,
      maxConsecutivePollFailures: 2,
    });
    const completion = begin(harness.result);
    await act(async () => Promise.resolve());

    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    await expect(completion).resolves.toMatchObject({
      message: '刷新状态无法确认，已保留现有内容',
    });
    expect(harness.result.current.active).toBe(false);
  });
});
