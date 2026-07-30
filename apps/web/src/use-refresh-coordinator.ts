import type { FeedOrigin, RunSummary, Topic, TrendStatus } from '@lettermate/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

export type RefreshNotificationKind = 'success' | 'warning' | 'error';

export interface RefreshNotification {
  id: number;
  kind: RefreshNotificationKind;
  message: string;
  ariaLive: 'polite';
}

export interface RefreshCoordinatorOptions {
  topics: Topic[];
  trendStatus: TrendStatus | undefined;
  origin: FeedOrigin;
  selectedTopicId?: string;
  refreshTopic: (topicId: string) => Promise<Topic>;
  refreshTrends: () => Promise<TrendStatus>;
  refetchTopics: () => Promise<Topic[] | undefined>;
  refetchTrendStatus: () => Promise<TrendStatus | undefined>;
  invalidateFeed: () => Promise<unknown>;
  now?: () => Date;
  pollIntervalMs?: number;
  maxConsecutivePollFailures?: number;
  confirmationTimeoutMs?: number;
  synchronizationTimeoutMs?: number;
}

export interface RefreshCoordinator {
  startRefresh: () => Promise<RefreshNotification | null>;
  active: boolean;
  targetCount: number;
  pendingCount: number;
  pendingTopicIds: string[];
  trendPending: boolean;
  synchronizing: boolean;
  synchronizationStale: boolean;
  retrySynchronization: () => Promise<boolean>;
  notification: RefreshNotification | null;
}

interface CoordinatorView {
  active: boolean;
  targetCount: number;
  pendingTopicIds: string[];
  trendPending: boolean;
  synchronizing: boolean;
  synchronizationStale: boolean;
  notification: RefreshNotification | null;
}

interface RefreshSession {
  targetCount: number;
  pendingTopicIds: Set<string>;
  trendPending: boolean;
  readyTopicIds: Set<string>;
  topicIgnoredRunIds: Map<string, Set<string>>;
  trendReady: boolean;
  trendIgnoredRunIds: Set<string>;
  succeededTargets: number;
  failedTargets: number;
  newItemCount: number;
  topicPollFailures: number;
  trendPollFailures: number;
  topicsPolling: boolean;
  trendPolling: boolean;
  finishing: boolean;
  completion: Promise<RefreshNotification | null>;
  resolve: (notification: RefreshNotification | null) => void;
}

const initialView: CoordinatorView = {
  active: false,
  targetCount: 0,
  pendingTopicIds: [],
  trendPending: false,
  synchronizing: false,
  synchronizationStale: false,
  notification: null,
};

function isNewManualTerminalRun(
  run: RunSummary | null,
  ignoredRunIds: ReadonlySet<string>,
): run is Extract<RunSummary, { status: 'succeeded' | 'failed' }> {
  return Boolean(
    run
    && !ignoredRunIds.has(run.id)
    && run.trigger === 'manual'
    && (run.status === 'succeeded' || run.status === 'failed'),
  );
}

function targetTopicIds(options: RefreshCoordinatorOptions): string[] {
  if (options.selectedTopicId) return [options.selectedTopicId];
  if (options.origin === 'trend') return [];
  return options.topics.map((topic) => topic.id);
}

function targetsTrend(options: RefreshCoordinatorOptions): boolean {
  return !options.selectedTopicId && options.origin !== 'topic';
}

function initialTopicBaselines(options: RefreshCoordinatorOptions, topicIds: string[]) {
  return new Map(topicIds.map((topicId) => {
    const runId = options.topics.find((topic) => topic.id === topicId)?.lastRun?.id;
    return [topicId, new Set(runId ? [runId] : [])] as const;
  }));
}

export function useRefreshCoordinator(options: RefreshCoordinatorOptions): RefreshCoordinator {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [view, setView] = useState<CoordinatorView>(initialView);
  const sessionRef = useRef<RefreshSession | null>(null);
  const timerRef = useRef<number | null>(null);
  const deadlineTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const notificationIdRef = useRef(0);
  const staleOutcomeRef = useRef<Omit<RefreshNotification, 'id'> | null>(null);
  const synchronizationRetryRef = useRef<Promise<boolean> | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (deadlineTimerRef.current !== null) {
      window.clearTimeout(deadlineTimerRef.current);
      deadlineTimerRef.current = null;
    }
  }, []);

  const syncView = useCallback((session: RefreshSession) => {
    if (!mountedRef.current) return;
    setView((current) => ({
      ...current,
      active: true,
      targetCount: session.targetCount,
      pendingTopicIds: [...session.pendingTopicIds],
      trendPending: session.trendPending,
    }));
  }, []);

  const completeSession = useCallback((
    session: RefreshSession,
    notification: Omit<RefreshNotification, 'id'>,
    synchronizationStale = false,
  ) => {
    if (sessionRef.current !== session) return;
    clearTimers();
    const payload: RefreshNotification = {
      ...notification,
      id: ++notificationIdRef.current,
    };
    sessionRef.current = null;
    if (mountedRef.current) {
      setView({
        active: false,
        targetCount: session.targetCount,
        pendingTopicIds: [],
        trendPending: false,
        synchronizing: false,
        synchronizationStale,
        notification: payload,
      });
    }
    session.resolve(payload);
  }, [clearTimers]);

  const synchronizeFeed = useCallback(async () => {
    let timeoutId: number | null = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => optionsRef.current.invalidateFeed()),
        new Promise<never>((_resolve, reject) => {
          timeoutId = window.setTimeout(
            () => reject(new Error('Feed synchronization timed out')),
            optionsRef.current.synchronizationTimeoutMs ?? 10_000,
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    }
  }, []);

  const finishUnconfirmed = useCallback((session: RefreshSession) => {
    if (sessionRef.current !== session || session.finishing) return;
    session.finishing = true;
    completeSession(session, {
      kind: 'warning',
      message: '刷新状态无法确认，已保留现有内容',
      ariaLive: 'polite',
    });
  }, [completeSession]);

  const finishConfirmed = useCallback((session: RefreshSession) => {
    let kind: RefreshNotificationKind;
    let message: string;
    if (session.failedTargets === 0) {
      kind = 'success';
      message = session.newItemCount > 0
        ? `刷新完成，新增 ${session.newItemCount} 条内容`
        : '刷新完成，暂无新增内容';
    } else if (session.succeededTargets > 0) {
      kind = 'warning';
      message = `部分更新失败，已新增 ${session.newItemCount} 条内容`;
    } else {
      kind = 'error';
      message = '刷新失败，已保留现有内容';
    }
    if (sessionRef.current !== session || session.finishing) return;
    session.finishing = true;
    clearTimers();
    const outcome = { kind, message, ariaLive: 'polite' as const };
    if (mountedRef.current) {
      setView((current) => ({
        ...current,
        active: true,
        pendingTopicIds: [],
        trendPending: false,
        synchronizing: true,
        notification: null,
      }));
    }
    void synchronizeFeed().then((synchronized) => {
      if (sessionRef.current !== session) return;
      if (synchronized) {
        staleOutcomeRef.current = null;
        completeSession(session, outcome);
      } else {
        staleOutcomeRef.current = outcome;
        completeSession(session, {
          kind: 'warning',
          message: '刷新结果已生成，但发现内容尚未同步',
          ariaLive: 'polite',
        }, true);
      }
    });
  }, [clearTimers, completeSession, synchronizeFeed]);

  const maybeFinish = useCallback((session: RefreshSession) => {
    if (session.pendingTopicIds.size === 0 && !session.trendPending) {
      finishConfirmed(session);
    }
  }, [finishConfirmed]);

  const acceptRun = useCallback((session: RefreshSession, run: RunSummary) => {
    if (run.status === 'succeeded') {
      session.succeededTargets += 1;
      session.newItemCount += run.newItemCount;
    } else {
      session.failedTargets += 1;
    }
  }, []);

  const recordPollFailure = useCallback((
    session: RefreshSession,
    target: 'topic' | 'trend',
  ) => {
    if (sessionRef.current !== session || session.finishing) return;
    if (target === 'topic') session.topicPollFailures += 1;
    else session.trendPollFailures += 1;
    const failures = target === 'topic'
      ? session.topicPollFailures
      : session.trendPollFailures;
    if (failures >= (optionsRef.current.maxConsecutivePollFailures ?? 4)) {
      finishUnconfirmed(session);
    }
  }, [finishUnconfirmed]);

  const pollRef = useRef<(session: RefreshSession) => void>(() => undefined);
  const schedulePoll = useCallback(function schedule(session: RefreshSession) {
    if (sessionRef.current !== session || session.finishing || timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      try {
        pollRef.current(session);
      } catch {
        finishUnconfirmed(session);
      }
      schedule(session);
    }, optionsRef.current.pollIntervalMs ?? 1_500);
  }, [finishUnconfirmed]);

  pollRef.current = (session: RefreshSession) => {
    if (sessionRef.current !== session || session.finishing) return;
    const currentOptions = optionsRef.current;

    if (session.pendingTopicIds.size > 0 && !session.topicsPolling) {
      session.topicsPolling = true;
      const readyAtLaunch = new Set(session.readyTopicIds);
      let request: Promise<Topic[] | undefined> | null = null;
      try {
        request = Promise.resolve(currentOptions.refetchTopics());
      } catch {
        session.topicsPolling = false;
        recordPollFailure(session, 'topic');
      }
      void request?.then((topics) => {
        session.topicsPolling = false;
        if (sessionRef.current !== session || session.finishing) return;
        session.topicPollFailures = 0;
        for (const topic of topics ?? []) {
          if (!session.pendingTopicIds.has(topic.id) || !readyAtLaunch.has(topic.id)) continue;
          const ignoredRunIds = session.topicIgnoredRunIds.get(topic.id) ?? new Set<string>();
          if (isNewManualTerminalRun(topic.lastRun, ignoredRunIds)) {
            session.pendingTopicIds.delete(topic.id);
            acceptRun(session, topic.lastRun);
          }
        }
        syncView(session);
        maybeFinish(session);
      }).catch(() => {
        session.topicsPolling = false;
        recordPollFailure(session, 'topic');
      }).catch(() => undefined);
    }

    if (session.trendPending && !session.trendPolling) {
      session.trendPolling = true;
      const readyAtLaunch = session.trendReady;
      let request: Promise<TrendStatus | undefined> | null = null;
      try {
        request = Promise.resolve(currentOptions.refetchTrendStatus());
      } catch {
        session.trendPolling = false;
        recordPollFailure(session, 'trend');
      }
      void request?.then((status) => {
        session.trendPolling = false;
        if (sessionRef.current !== session || session.finishing) return;
        session.trendPollFailures = 0;
        if (
          readyAtLaunch
          && isNewManualTerminalRun(status?.lastRun ?? null, session.trendIgnoredRunIds)
        ) {
          session.trendPending = false;
          acceptRun(session, status!.lastRun!);
        }
        syncView(session);
        maybeFinish(session);
      }).catch(() => {
        session.trendPolling = false;
        recordPollFailure(session, 'trend');
      }).catch(() => undefined);
    }
  };

  const startRefresh = useCallback((): Promise<RefreshNotification | null> => {
    const existing = sessionRef.current;
    if (existing) return existing.completion;

    staleOutcomeRef.current = null;
    const currentOptions = optionsRef.current;
    const topicIds = targetTopicIds(currentOptions);
    const trendTargeted = targetsTrend(currentOptions);
    let resolve!: (notification: RefreshNotification | null) => void;
    const completion = new Promise<RefreshNotification | null>((done) => { resolve = done; });
    const initialTrendRunId = currentOptions.trendStatus?.lastRun?.id;
    const session: RefreshSession = {
      targetCount: topicIds.length + Number(trendTargeted),
      pendingTopicIds: new Set(topicIds),
      trendPending: trendTargeted,
      readyTopicIds: new Set(),
      topicIgnoredRunIds: initialTopicBaselines(currentOptions, topicIds),
      trendReady: false,
      trendIgnoredRunIds: new Set(initialTrendRunId ? [initialTrendRunId] : []),
      succeededTargets: 0,
      failedTargets: 0,
      newItemCount: 0,
      topicPollFailures: 0,
      trendPollFailures: 0,
      topicsPolling: false,
      trendPolling: false,
      finishing: false,
      completion,
      resolve,
    };
    sessionRef.current = session;
    deadlineTimerRef.current = window.setTimeout(
      () => finishUnconfirmed(session),
      currentOptions.confirmationTimeoutMs ?? 12 * 60 * 1_000,
    );
    if (mountedRef.current) {
      setView((current) => ({
        ...current,
        active: true,
        targetCount: session.targetCount,
        pendingTopicIds: topicIds,
        trendPending: trendTargeted,
        synchronizing: false,
        synchronizationStale: false,
        notification: null,
      }));
    }
    schedulePoll(session);

    for (const topicId of topicIds) {
      void (async () => {
        try {
          const response = await currentOptions.refreshTopic(topicId);
          if (sessionRef.current !== session || session.finishing) return;
          if (
            response.lastRun
            && !(response.lastRun.trigger === 'manual'
              && response.lastRun.status === 'queued')
          ) {
            session.topicIgnoredRunIds.get(topicId)?.add(response.lastRun.id);
          }
          session.readyTopicIds.add(topicId);
        } catch {
          if (sessionRef.current !== session || session.finishing) return;
          if (session.pendingTopicIds.delete(topicId)) session.failedTargets += 1;
          syncView(session);
          maybeFinish(session);
        }
      })().catch(() => {
        if (sessionRef.current !== session || session.finishing) return;
        if (session.pendingTopicIds.delete(topicId)) session.failedTargets += 1;
        syncView(session);
        maybeFinish(session);
      });
    }

    if (trendTargeted) {
      void (async () => {
        try {
          const response = await currentOptions.refreshTrends();
          if (sessionRef.current !== session || session.finishing) return;
          if (
            response.lastRun
            && !(response.lastRun.trigger === 'manual'
              && response.lastRun.status === 'queued')
          ) {
            session.trendIgnoredRunIds.add(response.lastRun.id);
          }
          session.trendReady = true;
        } catch {
          if (sessionRef.current !== session || session.finishing) return;
          if (session.trendPending) {
            session.trendPending = false;
            session.failedTargets += 1;
          }
          syncView(session);
          maybeFinish(session);
        }
      })().catch(() => {
        if (sessionRef.current !== session || session.finishing) return;
        if (session.trendPending) {
          session.trendPending = false;
          session.failedTargets += 1;
        }
        syncView(session);
        maybeFinish(session);
      });
    }

    if (session.targetCount === 0) maybeFinish(session);
    return completion;
  }, [finishUnconfirmed, maybeFinish, schedulePoll, syncView]);

  const retrySynchronization = useCallback((): Promise<boolean> => {
    if (synchronizationRetryRef.current) return synchronizationRetryRef.current;
    const outcome = staleOutcomeRef.current;
    if (!outcome) return Promise.resolve(false);
    if (mountedRef.current) {
      setView((current) => ({ ...current, synchronizing: true }));
    }
    const retry = synchronizeFeed().then((synchronized) => {
      if (!mountedRef.current || staleOutcomeRef.current !== outcome) return false;
      const notification = synchronized
        ? outcome
        : {
            kind: 'warning' as const,
            message: '刷新结果已生成，但发现内容尚未同步',
            ariaLive: 'polite' as const,
          };
      if (synchronized) staleOutcomeRef.current = null;
      setView((current) => ({
        ...current,
        synchronizing: false,
        synchronizationStale: !synchronized,
        notification: {
          ...notification,
          id: ++notificationIdRef.current,
        },
      }));
      return synchronized;
    }).finally(() => {
      synchronizationRetryRef.current = null;
    });
    synchronizationRetryRef.current = retry;
    return retry;
  }, [synchronizeFeed]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      const session = sessionRef.current;
      sessionRef.current = null;
      session?.resolve(null);
    };
  }, [clearTimers]);

  return {
    startRefresh,
    active: view.active,
    targetCount: view.targetCount,
    pendingCount: view.pendingTopicIds.length + Number(view.trendPending),
    pendingTopicIds: view.pendingTopicIds,
    trendPending: view.trendPending,
    synchronizing: view.synchronizing,
    synchronizationStale: view.synchronizationStale,
    retrySynchronization,
    notification: view.notification,
  };
}
