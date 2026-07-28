import type { RunSummary, Topic } from '@lettermate/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefreshNotification, RefreshNotificationKind } from './use-refresh-coordinator.js';

export interface TopicRefreshNotification extends RefreshNotification {
  topicId: string;
  topicKeyword: string;
}

export interface TopicRefreshManagerOptions {
  topics: Topic[];
  refreshTopic: (topicId: string) => Promise<Topic>;
  refetchTopics: () => Promise<Topic[] | undefined>;
  invalidateFeed: () => Promise<unknown>;
  pollIntervalMs?: number;
  maxConsecutivePollFailures?: number;
  confirmationTimeoutMs?: number;
  synchronizationTimeoutMs?: number;
  onActivityChange?: (active: boolean) => void;
}

export interface TopicRefreshManager {
  startTopicRefresh: (topicId: string) => Promise<TopicRefreshNotification | null>;
  pendingTopicIds: string[];
  synchronizationStaleTopicIds: string[];
  retrySynchronization: (topicId: string) => Promise<boolean>;
  notifications: Record<string, TopicRefreshNotification>;
}

interface TopicOutcome {
  kind: RefreshNotificationKind;
  message: string;
}

interface TopicSession {
  topicId: string;
  keyword: string;
  ignoredRunIds: Set<string>;
  ready: boolean;
  stage: 'polling' | 'synchronizing' | 'stale';
  outcome: TopicOutcome | null;
  synchronization: Promise<boolean> | null;
  deadline: number;
  completion: Promise<TopicRefreshNotification | null>;
  resolve: (notification: TopicRefreshNotification | null) => void;
}

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

function outcomeForRun(keyword: string, run: Extract<RunSummary, { status: 'succeeded' | 'failed' }>) {
  if (run.status === 'failed') {
    return { kind: 'error' as const, message: `${keyword}：刷新失败，已保留现有内容` };
  }
  return {
    kind: 'success' as const,
    message: run.newItemCount > 0
      ? `${keyword}：刷新完成，新增 ${run.newItemCount} 条内容`
      : `${keyword}：刷新完成，暂无新增内容`,
  };
}

export function useTopicRefreshManager(options: TopicRefreshManagerOptions): TopicRefreshManager {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionsRef = useRef(new Map<string, TopicSession>());
  const timerRef = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const pollFailuresRef = useRef(0);
  const mountedRef = useRef(true);
  const notificationIdRef = useRef(0);
  const activeRef = useRef(false);
  const [pendingTopicIds, setPendingTopicIds] = useState<string[]>([]);
  const [synchronizationStaleTopicIds, setSynchronizationStaleTopicIds] = useState<string[]>([]);
  const [notifications, setNotifications] = useState<Record<string, TopicRefreshNotification>>({});

  const syncPending = useCallback(() => {
    const sessions = [...sessionsRef.current.values()];
    if (mountedRef.current) {
      setPendingTopicIds(sessions.map((session) => session.topicId));
      setSynchronizationStaleTopicIds(
        sessions.filter((session) => session.stage === 'stale').map((session) => session.topicId),
      );
    }
    const active = sessions.length > 0;
    if (activeRef.current !== active) {
      activeRef.current = active;
      optionsRef.current.onActivityChange?.(active);
    }
  }, []);

  const publish = useCallback((
    session: TopicSession,
    kind: RefreshNotificationKind,
    message: string,
    settle = true,
  ) => {
    const notification: TopicRefreshNotification = {
      id: ++notificationIdRef.current,
      topicId: session.topicId,
      topicKeyword: session.keyword,
      kind,
      message,
      ariaLive: 'polite',
    };
    if (mountedRef.current) {
      setNotifications((current) => ({ ...current, [session.topicId]: notification }));
    }
    if (settle) session.resolve(notification);
  }, []);

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

  const finishUnconfirmed = useCallback((sessions: TopicSession[]) => {
    for (const session of sessions) {
      if (sessionsRef.current.get(session.topicId) !== session) continue;
      sessionsRef.current.delete(session.topicId);
      publish(session, 'warning', `${session.keyword}：刷新状态无法确认，已保留现有内容`);
    }
    syncPending();
  }, [publish, syncPending]);

  const pollRef = useRef<() => Promise<void>>(async () => undefined);
  const hasPollingSessions = useCallback(() => (
    [...sessionsRef.current.values()].some((session) => session.stage === 'polling')
  ), []);
  const schedulePoll = useCallback(function schedule() {
    if (timerRef.current !== null || !hasPollingSessions()) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void pollRef.current().finally(schedule);
    }, optionsRef.current.pollIntervalMs ?? 1_500);
  }, [hasPollingSessions]);

  pollRef.current = async () => {
    if (pollingRef.current || !hasPollingSessions()) return;
    const expired = [...sessionsRef.current.values()].filter((session) => (
      session.stage === 'polling' && Date.now() >= session.deadline
    ));
    if (expired.length > 0) finishUnconfirmed(expired);
    if (!hasPollingSessions()) return;

    pollingRef.current = true;
    const readyAtLaunch = new Set(
      [...sessionsRef.current.values()]
        .filter((session) => session.stage === 'polling' && session.ready)
        .map((session) => session.topicId),
    );
    try {
      const topics = await optionsRef.current.refetchTopics();
      pollFailuresRef.current = 0;
      const completed: Array<{
        session: TopicSession;
        run: Extract<RunSummary, { status: 'succeeded' | 'failed' }>;
      }> = [];
      for (const topic of topics ?? []) {
        const session = sessionsRef.current.get(topic.id);
        if (!session || session.stage !== 'polling' || !readyAtLaunch.has(topic.id)) continue;
        if (isNewManualTerminalRun(topic.lastRun, session.ignoredRunIds)) {
          completed.push({ session, run: topic.lastRun });
          session.stage = 'synchronizing';
          session.outcome = outcomeForRun(session.keyword, topic.lastRun);
        }
      }
      if (completed.length > 0) {
        syncPending();
        void synchronizeFeed().then((synchronized) => {
          for (const { session } of completed) {
            if (
              sessionsRef.current.get(session.topicId) !== session
              || session.stage !== 'synchronizing'
              || !session.outcome
            ) continue;
            if (synchronized) {
              sessionsRef.current.delete(session.topicId);
              publish(session, session.outcome.kind, session.outcome.message);
            } else {
              session.stage = 'stale';
              publish(
                session,
                'warning',
                `${session.keyword}：刷新结果已生成，但发现内容尚未同步`,
                false,
              );
            }
          }
          syncPending();
        });
      }
    } catch {
      pollFailuresRef.current += 1;
      if (pollFailuresRef.current >= (optionsRef.current.maxConsecutivePollFailures ?? 4)) {
        finishUnconfirmed(
          [...sessionsRef.current.values()].filter((session) => session.stage === 'polling'),
        );
      }
    } finally {
      pollingRef.current = false;
    }
  };

  const startTopicRefresh = useCallback((topicId: string): Promise<TopicRefreshNotification | null> => {
    const existing = sessionsRef.current.get(topicId);
    if (existing) return existing.completion;
    const topic = optionsRef.current.topics.find((candidate) => candidate.id === topicId);
    if (!topic) return Promise.resolve(null);

    let resolve!: (notification: TopicRefreshNotification | null) => void;
    const completion = new Promise<TopicRefreshNotification | null>((done) => { resolve = done; });
    const session: TopicSession = {
      topicId,
      keyword: topic.keyword,
      ignoredRunIds: new Set(topic.lastRun ? [topic.lastRun.id] : []),
      ready: false,
      stage: 'polling',
      outcome: null,
      synchronization: null,
      deadline: Date.now() + (optionsRef.current.confirmationTimeoutMs ?? 12 * 60 * 1_000),
      completion,
      resolve,
    };
    sessionsRef.current.set(topicId, session);
    if (mountedRef.current) {
      setNotifications((current) => {
        const next = { ...current };
        delete next[topicId];
        return next;
      });
    }
    syncPending();
    schedulePoll();

    void Promise.resolve().then(() => optionsRef.current.refreshTopic(topicId)).then((response) => {
      if (sessionsRef.current.get(topicId) !== session) return;
      if (response.lastRun) session.ignoredRunIds.add(response.lastRun.id);
      session.ready = true;
    }).catch(() => {
      if (!sessionsRef.current.delete(topicId)) return;
      publish(session, 'error', `${session.keyword}：刷新失败，已保留现有内容`);
      syncPending();
    });
    return completion;
  }, [publish, schedulePoll, syncPending]);

  const retrySynchronization = useCallback((topicId: string): Promise<boolean> => {
    const session = sessionsRef.current.get(topicId);
    if (!session || session.stage !== 'stale' || !session.outcome) return Promise.resolve(false);
    if (session.synchronization) return session.synchronization;
    session.stage = 'synchronizing';
    syncPending();
    const synchronization = synchronizeFeed().then((synchronized) => {
      if (
        sessionsRef.current.get(topicId) !== session
        || session.stage !== 'synchronizing'
        || !session.outcome
      ) return false;
      if (synchronized) {
        sessionsRef.current.delete(topicId);
        publish(session, session.outcome.kind, session.outcome.message);
      } else {
        session.stage = 'stale';
        publish(
          session,
          'warning',
          `${session.keyword}：刷新结果已生成，但发现内容尚未同步`,
          false,
        );
      }
      syncPending();
      return synchronized;
    }).finally(() => {
      if (session.synchronization === synchronization) session.synchronization = null;
    });
    session.synchronization = synchronization;
    return synchronization;
  }, [publish, syncPending, synchronizeFeed]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      for (const session of sessionsRef.current.values()) session.resolve(null);
      sessionsRef.current.clear();
      activeRef.current = false;
    };
  }, []);

  return {
    startTopicRefresh,
    pendingTopicIds,
    synchronizationStaleTopicIds,
    retrySynchronization,
    notifications,
  };
}
