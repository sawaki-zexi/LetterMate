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
  refreshTopic: (topicId: string) => Promise<unknown>;
  refreshTrends: () => Promise<unknown>;
  refetchTopics: () => Promise<Topic[] | undefined>;
  refetchTrendStatus: () => Promise<TrendStatus | undefined>;
  invalidateFeed: () => Promise<unknown>;
  now?: () => Date;
  pollIntervalMs?: number;
  maxConsecutivePollFailures?: number;
  confirmationTimeoutMs?: number;
}

export interface RefreshCoordinator {
  startRefresh: () => Promise<RefreshNotification | null>;
  active: boolean;
  targetCount: number;
  pendingCount: number;
  pendingTopicIds: string[];
  trendPending: boolean;
  notification: RefreshNotification | null;
}

interface CoordinatorView {
  active: boolean;
  targetCount: number;
  pendingTopicIds: string[];
  trendPending: boolean;
  notification: RefreshNotification | null;
}

interface RefreshSession {
  requestBoundary: number;
  deadline: number;
  targetCount: number;
  pendingTopicIds: Set<string>;
  trendPending: boolean;
  baselineTopicRunIds: Map<string, string | null>;
  baselineTrendRunId: string | null;
  succeededTargets: number;
  failedTargets: number;
  newItemCount: number;
  consecutivePollFailures: number;
  polling: boolean;
  finishing: boolean;
  completion: Promise<RefreshNotification | null>;
  resolve: (notification: RefreshNotification | null) => void;
}

const initialView: CoordinatorView = {
  active: false,
  targetCount: 0,
  pendingTopicIds: [],
  trendPending: false,
  notification: null,
};

function isLaterManualTerminalRun(
  run: RunSummary | null,
  baselineRunId: string | null,
  requestBoundary: number,
): run is Extract<RunSummary, { status: 'succeeded' | 'failed' }> {
  return Boolean(
    run
    && run.id !== baselineRunId
    && run.trigger === 'manual'
    && (run.status === 'succeeded' || run.status === 'failed')
    && new Date(run.startedAt).getTime() >= requestBoundary,
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

export function useRefreshCoordinator(options: RefreshCoordinatorOptions): RefreshCoordinator {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [view, setView] = useState<CoordinatorView>(initialView);
  const sessionRef = useRef<RefreshSession | null>(null);
  const timerRef = useRef<number | null>(null);
  const deadlineTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const notificationIdRef = useRef(0);

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

  const finish = useCallback(async (
    session: RefreshSession,
    notification: Omit<RefreshNotification, 'id'>,
    refreshFeed: boolean,
  ) => {
    if (sessionRef.current !== session || session.finishing) return;
    session.finishing = true;
    clearTimers();
    if (refreshFeed) {
      try {
        await optionsRef.current.invalidateFeed();
      } catch {
        // The authoritative run result still completes the refresh; cached Feed remains intact.
      }
    }
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
        notification: payload,
      });
    }
    session.resolve(payload);
  }, [clearTimers]);

  const finishUnconfirmed = useCallback((session: RefreshSession) => {
    void finish(session, {
      kind: 'warning',
      message: '刷新状态无法确认，已保留现有内容',
      ariaLive: 'polite',
    }, false);
  }, [finish]);

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
    void finish(session, { kind, message, ariaLive: 'polite' }, true);
  }, [finish]);

  const acceptRun = useCallback((session: RefreshSession, run: RunSummary) => {
    if (run.status === 'succeeded') {
      session.succeededTargets += 1;
      session.newItemCount += run.newItemCount;
    } else {
      session.failedTargets += 1;
    }
  }, []);

  const pollRef = useRef<(session: RefreshSession) => Promise<void>>(async () => undefined);
  const schedulePoll = useCallback(function schedule(session: RefreshSession) {
    if (
      sessionRef.current !== session
      || session.finishing
      || session.polling
      || timerRef.current !== null
    ) return;
    const delay = optionsRef.current.pollIntervalMs ?? 1_500;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      session.polling = true;
      void pollRef.current(session).finally(() => {
        session.polling = false;
        schedule(session);
      });
    }, delay);
  }, []);

  pollRef.current = async (session: RefreshSession) => {
    if (sessionRef.current !== session || session.finishing) return;
    const currentOptions = optionsRef.current;
    const [topicsResult, trendResult] = await Promise.allSettled([
      currentOptions.refetchTopics(),
      currentOptions.refetchTrendStatus(),
    ]);
    if (sessionRef.current !== session || session.finishing) return;

    const topicConfirmationFailed = session.pendingTopicIds.size > 0
      && topicsResult.status === 'rejected';
    const trendConfirmationFailed = session.trendPending && trendResult.status === 'rejected';
    if (topicConfirmationFailed || trendConfirmationFailed) {
      session.consecutivePollFailures += 1;
    } else {
      session.consecutivePollFailures = 0;
    }

    if (topicsResult.status === 'fulfilled') {
      for (const topic of topicsResult.value ?? []) {
        if (!session.pendingTopicIds.has(topic.id)) continue;
        const baselineId = session.baselineTopicRunIds.get(topic.id) ?? null;
        if (isLaterManualTerminalRun(topic.lastRun, baselineId, session.requestBoundary)) {
          session.pendingTopicIds.delete(topic.id);
          acceptRun(session, topic.lastRun);
        }
      }
    }
    if (
      session.trendPending
      && trendResult.status === 'fulfilled'
      && isLaterManualTerminalRun(
        trendResult.value?.lastRun ?? null,
        session.baselineTrendRunId,
        session.requestBoundary,
      )
    ) {
      session.trendPending = false;
      acceptRun(session, trendResult.value!.lastRun!);
    }

    syncView(session);
    if (session.pendingTopicIds.size === 0 && !session.trendPending) {
      finishConfirmed(session);
      return;
    }
    const maxFailures = currentOptions.maxConsecutivePollFailures ?? 4;
    if (session.consecutivePollFailures >= maxFailures || Date.now() >= session.deadline) {
      finishUnconfirmed(session);
      return;
    }
  };

  const startRefresh = useCallback((): Promise<RefreshNotification | null> => {
    const existing = sessionRef.current;
    if (existing) return existing.completion;

    const currentOptions = optionsRef.current;
    const topicIds = targetTopicIds(currentOptions);
    const trendTargeted = targetsTrend(currentOptions);
    const requestBoundary = (currentOptions.now ?? (() => new Date()))().getTime();
    let resolve!: (notification: RefreshNotification | null) => void;
    const completion = new Promise<RefreshNotification | null>((done) => { resolve = done; });
    const session: RefreshSession = {
      requestBoundary,
      deadline: Date.now() + (currentOptions.confirmationTimeoutMs ?? 12 * 60 * 1_000),
      targetCount: topicIds.length + Number(trendTargeted),
      pendingTopicIds: new Set(topicIds),
      trendPending: trendTargeted,
      baselineTopicRunIds: new Map(topicIds.map((topicId) => [
        topicId,
        currentOptions.topics.find((topic) => topic.id === topicId)?.lastRun?.id ?? null,
      ])),
      baselineTrendRunId: currentOptions.trendStatus?.lastRun?.id ?? null,
      succeededTargets: 0,
      failedTargets: 0,
      newItemCount: 0,
      consecutivePollFailures: 0,
      polling: false,
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
        notification: null,
      }));
    }
    schedulePoll(session);

    void (async () => {
      const topicTriggers = topicIds.map(async (topicId) => {
        try {
          await currentOptions.refreshTopic(topicId);
        } catch {
          if (session.pendingTopicIds.delete(topicId)) session.failedTargets += 1;
        }
      });
      const trendTrigger = trendTargeted
        ? (async () => {
            try {
              await currentOptions.refreshTrends();
            } catch {
              if (session.trendPending) {
                session.trendPending = false;
                session.failedTargets += 1;
              }
            }
          })()
        : Promise.resolve();
      await Promise.all([...topicTriggers, trendTrigger]);
      if (sessionRef.current !== session || session.finishing) return;
      syncView(session);
      if (session.pendingTopicIds.size === 0 && !session.trendPending) {
        finishConfirmed(session);
      }
    })();

    return completion;
  }, [finishConfirmed, finishUnconfirmed, schedulePoll, syncView]);

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
    notification: view.notification,
  };
}
