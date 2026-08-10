import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Creator,
  CreatorItem,
  CreatorIdentityCandidate,
  CreatorPlatformStatus,
  AuthSession,
  DiscoveryKind,
  DiscoverySourceStatus,
  DigestPreference,
  DigestRecentRun,
  DigestStatus,
  FeedItem,
  FeedRange,
  FeedbackValue,
  InterestMemory,
  InterestMemoryTheme,
  SourceType,
  Topic,
  TrendStatus,
} from '@lettermate/contracts';
import {
  AlertCircle,
  BadgeCheck,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Clock3,
  ExternalLink,
  EyeOff,
  Inbox,
  Menu,
  Mail,
  LogIn,
  LogOut,
  Newspaper,
  Pause,
  Play,
  Plus,
  Pencil,
  RefreshCw,
  Rss,
  Search,
  Trash2,
  UserSearch,
  UserPlus,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { api } from './api.js';
import { DiscoveryCard } from './components/DiscoveryCard.js';
import { discoveryKindLabels } from './discovery-display.js';
import { groupFeedItems } from './feed-time.js';
import {
  feedFilterForSource,
  topicSourceSelection,
  type FeedSourceSelection,
} from './feed-source-selection.js';
import { usePullRefresh } from './use-pull-refresh.js';
import {
  useRefreshCoordinator,
  type RefreshCoordinator,
  type RefreshNotification,
} from './use-refresh-coordinator.js';
import { useTopicRefreshManager, type TopicRefreshNotification } from './use-topic-refresh-manager.js';

const navigation = [
  { to: '/', label: '发现', icon: Newspaper },
  { to: '/topics', label: '关键词监控', icon: Search },
  { to: '/creators', label: '博主关注', icon: Rss },
  { to: '/interests', label: '兴趣记忆', icon: BrainCircuit },
  { to: '/digest', label: '每日邮件', icon: Mail },
];

const timeZones = typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone')
  : ['Asia/Shanghai', 'Asia/Tokyo', 'UTC', 'Europe/London', 'America/New_York'];

const creatorPlatformLabels = {
  rss: 'RSS/Atom',
  x: 'X',
  bilibili: 'Bilibili',
  youtube: 'YouTube',
  bluesky: 'Bluesky',
} as const;

const creatorDegradedSourceLabels: Record<string, string> = {
  dynamic: '动态流',
};

const statusLabel: Record<Topic['runStatus'], string> = {
  queued: '等待多源发现',
  running: '多源发现中',
  succeeded: '已完成',
  degraded: '部分同步',
  failed: '失败',
};

const isRunActive = (status: Topic['runStatus']): boolean => (
  status === 'queued' || status === 'running'
);

const isTrendRunActive = (status: TrendStatus): boolean => (
  isRunActive(status.runStatus)
  && status.lastRun !== null
  && isRunActive(status.lastRun.status)
);

const sourceTypeLabel: Record<SourceType, string> = {
  web: '网页',
  feed: '订阅',
  social: '社交',
  video: '视频',
  community: '社区',
  code: '代码',
  paper: '论文',
};

function useTopics(suppressBackgroundPolling = false) {
  return useQuery({
    queryKey: ['topics'],
    queryFn: api.topics,
    refetchInterval: (query) => !suppressBackgroundPolling && query.state.data?.some((topic) =>
      topic.runStatus === 'queued' || topic.runStatus === 'running') ? 1_500 : false,
  });
}

function useDiscoverySources() {
  return useQuery({ queryKey: ['discovery-sources'], queryFn: api.discoverySources });
}

function useTrendStatus() {
  return useQuery({
    queryKey: ['trend-status'],
    queryFn: api.trendStatus,
    refetchInterval: (query) => query.state.data && isTrendRunActive(query.state.data)
      ? 1_500
      : false,
  });
}

function QueryState({ isLoading, error, retry }: { isLoading: boolean; error: Error | null; retry: () => void }) {
  if (isLoading) return <div className="state"><RefreshCw className="spin" />正在加载</div>;
  if (error) return (
    <div className="state state--error">
      <AlertCircle />
      <strong>无法加载数据</strong>
      <span>{error.message}</span>
      <button className="button button--secondary" onClick={retry}><RefreshCw size={16} />重试</button>
    </div>
  );
  return null;
}

function TopicErrors({ topics }: { topics: Topic[] }) {
  const failed = topics.filter((topic) => topic.lastError);
  if (failed.length === 0) return null;
  return (
    <div className="error-stack" aria-live="polite">
      {failed.map((topic) => (
        <div className="error-banner" key={topic.id}>
          <AlertCircle size={18} />
          <div><strong>{topic.keyword}</strong><span>{topic.lastError?.message}</span></div>
        </div>
      ))}
    </div>
  );
}

function RefreshNotificationToast({ notification }: { notification: RefreshNotification | null }) {
  const [displayed, setDisplayed] = useState<RefreshNotification | null>(null);

  useEffect(() => {
    if (!notification) {
      setDisplayed(null);
      return;
    }
    setDisplayed(null);
    const timer = window.setTimeout(() => setDisplayed(notification), 0);
    return () => window.clearTimeout(timer);
  }, [notification]);

  return (
    <div
      className={displayed
        ? `refresh-toast refresh-toast--${displayed.kind}`
        : 'refresh-announcer'}
      aria-label="刷新结果"
      aria-live="polite"
      aria-atomic="true"
      data-notification-id={displayed?.id}
    >
      {displayed?.message ?? ''}
    </div>
  );
}

function TopicRefreshResults({
  notifications,
  synchronizationStaleTopicIds,
  retrySynchronization,
}: {
  notifications: Record<string, TopicRefreshNotification>;
  synchronizationStaleTopicIds: string[];
  retrySynchronization: (topicId: string) => Promise<boolean>;
}) {
  const results = Object.values(notifications);
  const staleTopicIds = new Set(synchronizationStaleTopicIds);
  return (
    <div
      className={results.length > 0 ? 'topic-refresh-results' : 'refresh-announcer'}
      aria-label="刷新结果"
      aria-live="polite"
      aria-atomic="false"
    >
      {results.map((notification) => (
        <div
          className={`topic-refresh-result topic-refresh-result--${notification.kind}`}
          data-notification-id={notification.id}
          key={notification.topicId}
        >
          <span>{notification.message}</span>
          {staleTopicIds.has(notification.topicId) && (
            <button
              className="button button--secondary"
              aria-label={`重试同步 ${notification.topicKeyword}`}
              onClick={() => void retrySynchronization(notification.topicId)}
            ><RefreshCw size={16} />重试同步</button>
          )}
        </div>
      ))}
    </div>
  );
}

function RefreshFeedback({
  refresh,
  active = refresh.active,
  targetCount = refresh.targetCount,
}: {
  refresh: RefreshCoordinator;
  active?: boolean;
  targetCount?: number;
}) {
  return (
    <>
      {active && (
        <div className="refresh-status" role="status">
          <RefreshCw className="spin" size={16} />
          <span>正在更新 {targetCount} 个目标</span>
        </div>
      )}
      <RefreshNotificationToast notification={refresh.notification} />
      {refresh.synchronizationStale && (
        <div className="error-banner">
          <AlertCircle size={18} />
          <span>刷新结果已生成，但发现内容尚未同步</span>
          <button
            className="button button--secondary"
            disabled={refresh.synchronizing}
            onClick={() => void refresh.retrySynchronization()}
          ><RefreshCw className={refresh.synchronizing ? 'spin' : undefined} size={16} />重试同步</button>
        </div>
      )}
    </>
  );
}

const timeRangeOptions: ReadonlyArray<[FeedRange, string]> = [
  ['1d', '近 24 小时'],
  ['3d', '近 3 天'],
  ['7d', '近 7 天'],
  ['30d', '近 30 天'],
  ['90d', '近 90 天'],
  ['all', '全部历史'],
];

function FeedPage() {
  const client = useQueryClient();
  const topics = useTopics();
  const trendStatus = useTrendStatus();
  const [kind, setKind] = useState<DiscoveryKind | 'all'>('all');
  const [range, setRange] = useState<FeedRange>('30d');
  const [sourceSelection, setSourceSelection] = useState<FeedSourceSelection>('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const { origin, topicId } = feedFilterForSource(sourceSelection);
  const filter = {
    range,
    origin,
    ...(topicId ? { topicId } : {}),
    ...(kind === 'all' ? {} : { kind }),
    ...(searchQuery ? { q: searchQuery } : {}),
  };
  const feed = useQuery({
    queryKey: ['feed', filter],
    queryFn: () => api.feed(filter),
  });
  const feedback = useMutation({
    mutationFn: ({ contentKey, value }: { contentKey: string; value: FeedbackValue | null }) => (
      api.setFeedback(contentKey, { value })
    ),
    onSuccess: (result) => {
      client.setQueriesData<FeedItem[]>({ queryKey: ['feed'] }, (items) => items?.map((item) => (
        item.contentKey === result.contentKey ? { ...item, feedback: result.value } : item
      )));
      client.setQueriesData<FeedItem>({ queryKey: ['item'] }, (item) => (
        item?.contentKey === result.contentKey ? { ...item, feedback: result.value } : item
      ));
    },
  });
  const impressionQueue = useRef(new Map<string, Set<string>>());
  const impressionTimer = useRef<number | null>(null);
  const flushImpressions = useCallback(() => {
    if (impressionTimer.current !== null) {
      window.clearTimeout(impressionTimer.current);
      impressionTimer.current = null;
    }
    const pending = impressionQueue.current;
    impressionQueue.current = new Map();
    for (const [decisionId, contentKeys] of pending) {
      void api.recordFeedImpressions({ decisionId, contentKeys: [...contentKeys] })
        .catch(() => undefined);
    }
  }, []);
  const queueImpression = useCallback((item: FeedItem) => {
    const decisionId = item.recommendation?.decisionId;
    if (!decisionId) return;
    const contentKeys = impressionQueue.current.get(decisionId) ?? new Set<string>();
    contentKeys.add(item.contentKey);
    impressionQueue.current.set(decisionId, contentKeys);
    if (impressionTimer.current === null) {
      impressionTimer.current = window.setTimeout(flushImpressions, 250);
    }
  }, [flushImpressions]);
  useEffect(() => () => flushImpressions(), [flushImpressions]);
  const refresh = useRefreshCoordinator({
    topics: topics.data ?? [],
    trendStatus: trendStatus.data,
    origin,
    ...(topicId ? { selectedTopicId: topicId } : {}),
    refreshTopic: api.refreshTopic,
    refreshTrends: api.refreshTrends,
    refetchTopics: api.topics,
    refetchTrendStatus: api.trendStatus,
    invalidateFeed: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['feed'] }, { throwOnError: true }),
        client.invalidateQueries({ queryKey: ['topics'] }, { throwOnError: true }),
        client.invalidateQueries({ queryKey: ['trend-status'] }, { throwOnError: true }),
      ]);
    },
  });
  const hasSelectedTopic = topicId
    ? topics.data?.some((topic) => topic.id === topicId) === true
    : false;
  const hasTopicTargets = topicId ? hasSelectedTopic : (topics.data?.length ?? 0) > 0;
  const refreshReady = origin === 'creator'
    ? false
    : origin === 'trend'
    ? trendStatus.data !== undefined
    : origin === 'topic'
      ? topics.data !== undefined && hasTopicTargets
      : topics.data !== undefined && trendStatus.data !== undefined;
  const activeTopicCount = origin === 'trend' || origin === 'creator'
    ? 0
    : (topics.data ?? []).filter((topic) => (
        (!topicId || topic.id === topicId) && isRunActive(topic.runStatus)
      )).length;
  const activeTrendCount = origin !== 'topic' && origin !== 'creator'
    && trendStatus.data
    && isTrendRunActive(trendStatus.data)
    ? 1
    : 0;
  const serverTargetCount = activeTopicCount + activeTrendCount;
  const refreshActive = refresh.active || serverTargetCount > 0;
  const refreshTargetCount = refresh.active ? refresh.targetCount : serverTargetCount;
  const pull = usePullRefresh({
    refreshing: refreshActive || !refreshReady,
    onRefresh: async () => { await refresh.startRefresh(); },
  });
  const groups = groupFeedItems(feed.data ?? []);

  useEffect(() => {
    if (topicId && topics.data && !hasSelectedTopic) setSourceSelection('all');
  }, [hasSelectedTopic, topicId, topics.data]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearchQuery(searchDraft.trim());
  };

  const clearSearch = () => {
    setSearchDraft('');
    setSearchQuery('');
  };

  return (
    <Page title="发现" description="从搜索、社交、视频与技术社区汇集高价值新内容" action={
      <button
        className="icon-button refresh-button"
        title="刷新发现"
        aria-label="刷新发现"
        aria-busy={refreshActive}
        disabled={refreshActive || !refreshReady}
        onClick={() => void refresh.startRefresh()}
      ><RefreshCw className={refreshActive ? 'spin' : undefined} size={18} /></button>
    } containerProps={pull.containerProps}>
      <div
        className={`pull-indicator ${pull.pullDistance > 0 ? 'pull-indicator--visible' : ''} ${pull.armed ? 'pull-indicator--armed' : ''} ${refreshActive ? 'pull-indicator--active' : ''}`}
        style={{ '--pull-distance': `${pull.pullDistance}px` } as CSSProperties}
        aria-hidden="true"
      >
        <RefreshCw className={refreshActive ? 'spin' : undefined} size={18} />
      </div>
      <RefreshFeedback refresh={refresh} active={refreshActive} targetCount={refreshTargetCount} />
      {(origin === 'all' || origin === 'trend') && trendStatus.error && (
        <div className="error-banner">
          <AlertCircle size={18} />
          <div><strong>趋势状态无法加载</strong><span>{trendStatus.error.message}</span></div>
          <button
            className="icon-button"
            title="重试趋势状态"
            aria-label="重试趋势状态"
            onClick={() => void trendStatus.refetch()}
          ><RefreshCw size={16} /></button>
        </div>
      )}
      <form
        className={`feed-search ${searchQuery ? 'feed-search--active' : ''}`}
        role="search"
        onSubmit={submitSearch}
      >
        <input
          aria-label="搜索已获取文章"
          maxLength={100}
          placeholder="搜索已获取文章"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
        />
        <button className="icon-button" type="submit" title="搜索文章" aria-label="搜索文章">
          {feed.isFetching && searchQuery ? <RefreshCw className="spin" size={17} /> : <Search size={17} />}
        </button>
        {searchQuery && (
          <button className="icon-button" type="button" title="清除搜索" aria-label="清除搜索" onClick={clearSearch}>
            <X size={17} />
          </button>
        )}
      </form>
      <div className="feed-tools">
        <div className="feed-segments">
          <div className="segmented" role="group" aria-label="内容类型">
            {(['all', 'hot', 'quality'] as const).map((value) => (
              <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>
                {value === 'all' ? '全部' : discoveryKindLabels[value]}
              </button>
            ))}
          </div>
        </div>
        <div className="feed-selects">
          <label className="filter-control source-filter">
            <span>来源</span>
            <select
              value={sourceSelection}
              onChange={(event) => setSourceSelection(event.target.value as FeedSourceSelection)}
            >
              <option value="all">全部来源</option>
              <option value="trend">全网趋势</option>
              <option value="creator">关注博主</option>
              {(topics.data ?? []).map((topic) => (
                <option key={topic.id} value={topicSourceSelection(topic.id)}>{topic.keyword}</option>
              ))}
            </select>
          </label>
          <label className="filter-control time-filter">
            <span>时间范围</span>
            <select value={range} onChange={(event) => setRange(event.target.value as FeedRange)}>
              {timeRangeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
      </div>
      <TopicErrors topics={topics.data ?? []} />
      {feedback.error && (
        <div className="error-banner" role="alert">
          <AlertCircle size={18} /><span>{feedback.error.message}</span>
        </div>
      )}
      {!topics.data && <QueryState isLoading={topics.isLoading} error={topics.error} retry={() => void topics.refetch()} />}
      {!feed.data && <QueryState isLoading={feed.isLoading} error={feed.error} retry={() => void feed.refetch()} />}
      {feed.data?.length === 0 && (
        <div className="state"><Inbox />{searchQuery ? '未找到匹配文章' : '暂无发现内容'}</div>
      )}
      <div className="feed-groups">
        {groups.map((group) => (
          <section className="feed-time-group" key={group.label}>
            <h2>{group.label}</h2>
            <div className="discovery-list">
              {group.items.map((item) => {
                return (
                  <DiscoveryCard
                    key={item.id}
                    item={item}
                    detailHref={`/items/${item.id}`}
                    headingLevel={3}
                    feedbackPending={feedback.isPending && feedback.variables?.contentKey === item.contentKey}
                    onFeedback={(value) => feedback.mutate({ contentKey: item.contentKey, value })}
                    onImpression={() => queueImpression(item)}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Page>
  );
}

function TopicRow({
  topic,
  pending,
  onRefresh,
  onUpdate,
  onTogglePaused,
  onDelete,
}: {
  topic: Topic;
  pending: boolean;
  onRefresh: () => void;
  onUpdate: (input: { keyword: string; expandedTerms: string[] }) => Promise<void>;
  onTogglePaused: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draftKeyword, setDraftKeyword] = useState(topic.keyword);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!draftKeyword.trim() || saving) return;
    setSaving(true); setError(null);
    try {
      await onUpdate({ keyword: draftKeyword.trim(), expandedTerms: [] });
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally { setSaving(false); }
  };
  const togglePaused = async () => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      await onTogglePaused();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '状态更新失败');
    } finally { setSaving(false); }
  };
  const paused = topic.pausedAt !== null;
  return (
    <article className="topic-row">
      <div className="topic-row__main">
        <div className="topic-row__title">{editing
          ? <input
              className="topic-row__keyword-input"
              aria-label="主关键词"
              autoFocus
              value={draftKeyword}
              maxLength={100}
              onChange={(event) => setDraftKeyword(event.target.value)}
            />
          : <h2>{topic.keyword}</h2>}
          <span className={`run-state run-state--${paused ? 'paused' : topic.runStatus}`}>
            {paused ? '已暂停' : statusLabel[topic.runStatus]}
          </span>
        </div>
        <p className="topic-schedule"><Clock3 size={14} />{paused
          ? '已暂停自动更新'
          : topic.nextRunAt
          ? `下次自动更新 ${new Date(topic.nextRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 每 ${topic.scheduleIntervalHours} 小时`
          : `每 ${topic.scheduleIntervalHours} 小时 · 等待首次自动更新`}</p>
        {error && <p className="inline-error"><AlertCircle size={15} />{error}</p>}
        {topic.lastError && <p className="inline-error"><AlertCircle size={15} />{topic.lastError.message}</p>}
      </div>
      <div className="topic-row__actions">{editing ? <>
        <button className="icon-button icon-button--success" type="button" title="保存修改" aria-label={`保存修改 ${topic.keyword}`} disabled={saving || !draftKeyword.trim()} onClick={() => void save()}><Check size={17} /></button>
        <button className="icon-button" type="button" title="取消修改" aria-label={`取消修改 ${topic.keyword}`} disabled={saving} onClick={() => { setError(null); setEditing(false); }}><X size={17} /></button>
      </> : <><button
        className="icon-button refresh-button"
        title="重新搜索"
        aria-label={`刷新 ${topic.keyword}`}
        aria-busy={pending}
        disabled={pending || paused}
        onClick={onRefresh}
      ><RefreshCw className={pending ? 'spin' : undefined} size={17} /></button>
      <button
        className="icon-button"
        type="button"
        title={paused ? '恢复监控' : '暂停监控'}
        aria-label={`${paused ? '恢复' : '暂停'} ${topic.keyword} 关键词监控`}
        disabled={saving}
        onClick={() => void togglePaused()}
      >{paused ? <Play size={17} /> : <Pause size={17} />}</button>
      <button className="icon-button" title="编辑" aria-label={`编辑 ${topic.keyword} 关键词`} onClick={() => { setDraftKeyword(topic.keyword); setEditing(true); }}><Pencil size={17} /></button>
      <button className="icon-button icon-button--danger" title="删除" aria-label={`删除 ${topic.keyword} 关键词`} onClick={() => setConfirmingDelete(true)}><Trash2 size={17} /></button></>}</div>
      {confirmingDelete && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-label="删除关键词确认">
        <h3>删除“{topic.keyword}”？</h3><p>关键词将从列表移除，历史内容仍会保留并标记为失效。</p>
        {error && <p className="inline-error">{error}</p>}
        <div><button className="text-button" onClick={() => setConfirmingDelete(false)}>取消</button><button className="button button--danger" autoFocus disabled={saving} onClick={() => { setSaving(true); setError(null); void onDelete().catch((cause) => setError(cause instanceof Error ? cause.message : '删除失败')).finally(() => setSaving(false)); }}>确认删除</button></div>
      </div></div>}
    </article>
  );
}

function PendingTopicRow({ keyword }: { keyword: string }) {
  return (
    <article
      className="topic-row topic-row--pending"
      role="status"
      aria-label={`正在创建 ${keyword}`}
    >
      <div className="topic-row__main">
        <div className="topic-row__title">
          <h2>{keyword}</h2>
          <span className="run-state run-state--queued">正在创建</span>
        </div>
        <p className="topic-schedule"><RefreshCw className="spin" size={14} />正在保存并排队</p>
      </div>
      <RefreshCw className="spin topic-row__pending-icon" size={17} aria-hidden="true" />
    </article>
  );
}

function TopicsPage() {
  const client = useQueryClient();
  const [manualTopicRefreshActive, setManualTopicRefreshActive] = useState(false);
  const topics = useTopics(manualTopicRefreshActive);
  const sources = useDiscoverySources();
  const enabledSourceCount = sources.data?.filter((source) => source.status === 'enabled').length ?? 0;
  const notConfiguredSourceCount = sources.data?.filter((source) => source.status === 'not_configured').length ?? 0;
  const [keyword, setKeyword] = useState('');
  const [pendingKeyword, setPendingKeyword] = useState<string | null>(null);
  const refresh = useTopicRefreshManager({
    topics: topics.data ?? [],
    refreshTopic: api.refreshTopic,
    refetchTopics: async () => (await topics.refetch()).data,
    invalidateFeed: () => client.invalidateQueries(
      { queryKey: ['feed'] },
      { throwOnError: true },
    ),
    onActivityChange: setManualTopicRefreshActive,
  });
  const create = useMutation({
    mutationFn: api.createTopic,
    onSuccess: (topic) => {
      client.setQueryData<Topic[]>(['topics'], (current = []) => [topic, ...current.filter((item) => item.id !== topic.id)]);
      setPendingKeyword(null);
      setKeyword('');
    },
    onError: (_error, input) => {
      setPendingKeyword(null);
      setKeyword((current) => current || input.keyword);
    },
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { keyword: string; expandedTerms: string[] } }) => api.updateTopic(id, input),
    onSuccess: (topic) => {
      client.setQueryData<Topic[]>(['topics'], (current = []) => current.map((item) => item.id === topic.id ? topic : item));
      void client.invalidateQueries({ queryKey: ['feed'] });
    },
  });
  const lifecycle = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => (
      paused ? api.resumeTopic(id) : api.pauseTopic(id)
    ),
    onSuccess: (topic) => {
      client.setQueryData<Topic[]>(['topics'], (current = []) => current.map((item) => (
        item.id === topic.id ? topic : item
      )));
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteTopic,
    onSuccess: (_result, id) => {
      client.setQueryData<Topic[]>(['topics'], (current = []) => current.filter((item) => item.id !== id));
      void client.invalidateQueries({ queryKey: ['feed'] });
    },
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const submittedKeyword = keyword.trim();
    if (!submittedKeyword || create.isPending) return;
    setPendingKeyword(submittedKeyword);
    setKeyword('');
    create.mutate({ keyword: submittedKeyword });
  };

  return (
      <Page title="关键词监控" description="输入一个关键词，自动发现重要事件与持续更新">
      <TopicRefreshResults
        notifications={refresh.notifications}
        synchronizationStaleTopicIds={refresh.synchronizationStaleTopicIds}
        retrySynchronization={refresh.retrySynchronization}
      />
      <form className="topic-create" onSubmit={submit}>
        <label htmlFor="topic-keyword">监控关键词</label>
        <input id="topic-keyword" value={keyword} maxLength={100} onChange={(event) => setKeyword(event.target.value)} placeholder="例如：AI Agent" />
        <button className="button" disabled={create.isPending || !keyword.trim()}><Plus size={17} />开始监控</button>
      </form>
      {create.error && <div className="error-banner"><AlertCircle size={18} /><span>{create.error.message}</span></div>}
      {!topics.data && <QueryState isLoading={topics.isLoading} error={topics.error} retry={() => void topics.refetch()} />}
      <div className="topic-list">
        {pendingKeyword && <PendingTopicRow keyword={pendingKeyword} />}
        {(topics.data ?? []).map((topic) => <TopicRow
          key={topic.id}
          topic={topic}
          pending={topic.pausedAt === null && (refresh.pendingTopicIds.includes(topic.id) || isRunActive(topic.runStatus))}
          onRefresh={() => void refresh.startTopicRefresh(topic.id)}
          onUpdate={(input) => update.mutateAsync({ id: topic.id, input }).then(() => undefined)}
          onTogglePaused={() => lifecycle.mutateAsync({
            id: topic.id,
            paused: topic.pausedAt !== null,
          }).then(() => undefined)}
          onDelete={() => remove.mutateAsync(topic.id)}
        />)}
        {topics.data?.length === 0 && !pendingKeyword && <div className="state"><Search />尚未创建关键词监控</div>}
      </div>
      <section className="source-status-section">
        <header><h2>信息来源</h2><span>{enabledSourceCount} 个已启用 · {notConfiguredSourceCount} 个未配置</span></header>
        <QueryState isLoading={sources.isLoading} error={sources.error} retry={() => void sources.refetch()} />
        <div className="source-status-list">
          {(sources.data ?? []).map((source: DiscoverySourceStatus) => (
            <div className="source-status-row" key={source.id}>
              <div><strong>{source.label}</strong><span>{sourceTypeLabel[source.category]}</span></div>
              <span className={`source-state source-state--${source.status}`}>
                {source.status === 'enabled' ? <CheckCircle2 size={15} /> : <CircleDashed size={15} />}
                {source.status === 'enabled' ? '已启用' : '未配置'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </Page>
  );
}

function CreatorRow({
  creator,
  pending,
  onRefresh,
  onTogglePaused,
  onDelete,
}: {
  creator: Creator;
  pending: boolean;
  onRefresh: () => void;
  onTogglePaused: () => void;
  onDelete: () => void;
}) {
  const paused = creator.pausedAt !== null;
  const active = isRunActive(creator.runStatus);
  const sourceUrl = creator.feedUrl ?? creator.profileUrl;
  return (
    <article className={`topic-row ${pending ? 'topic-row--pending' : ''}`}>
      <div className="topic-row__main">
        <div className="topic-row__title">
          <h2>{creator.displayName}</h2>
          <span className={`run-state run-state--${paused ? 'paused' : creator.runStatus}`}>
            {paused ? '已暂停' : statusLabel[creator.runStatus]}
          </span>
        </div>
        <a className="text-link creator-feed-url" href={sourceUrl} target="_blank" rel="noreferrer noopener">
          <ExternalLink size={14} />{creatorPlatformLabels[creator.platform]} · {sourceUrl}
        </a>
        <p className="topic-schedule"><Clock3 size={14} />{
          paused
            ? '已停止每日同步'
            : creator.nextRunAt
              ? `下次同步 ${new Date(creator.nextRunAt).toLocaleString('zh-CN')}`
              : active ? '首次同步已入队' : '等待下次同步'
        }</p>
        {creator.runStatus === 'degraded' && creator.degradedSources.length > 0 && (
          <p className="inline-warning">
            <AlertCircle size={14} />
            {creator.degradedSources.map((source) => creatorDegradedSourceLabels[source.source] ?? source.source).join('、')}
            {' '}暂不可用，已保留可用内容
          </p>
        )}
        {creator.lastError && <p className="inline-error"><AlertCircle size={14} />{creator.lastError.message}</p>}
      </div>
      <div className="topic-row__actions">
        <Link className="icon-button" to={`/creators/${encodeURIComponent(creator.id)}`} title="查看内容" aria-label={`查看 ${creator.displayName} 的内容`}>
          <Newspaper size={17} />
        </Link>
        <button className="icon-button" title={paused ? '恢复关注' : '暂停关注'} aria-label={paused ? `恢复关注 ${creator.displayName}` : `暂停关注 ${creator.displayName}`} disabled={pending} onClick={onTogglePaused}>
          {paused ? <Play size={17} /> : <Pause size={17} />}
        </button>
        <button className="icon-button" title="立即同步" aria-label={`立即同步 ${creator.displayName}`} disabled={pending || paused || active} onClick={onRefresh}>
          <RefreshCw className={pending ? 'spin' : undefined} size={17} />
        </button>
        <button className="icon-button icon-button--danger" title="取消关注" aria-label={`取消关注 ${creator.displayName}`} disabled={pending} onClick={onDelete}>
          <Trash2 size={17} />
        </button>
      </div>
    </article>
  );
}

const creatorContentTypeLabels: Record<CreatorItem['contentType'], string> = {
  original: '原创',
  repost: '转发',
  reply: '回复',
};

function CreatorContentCard({ item }: { item: CreatorItem }) {
  const author = [item.authorName, item.authorHandle ? `@${item.authorHandle}` : null]
    .filter(Boolean)
    .join(' · ');
  const originalAuthor = [
    item.originalAuthorName,
    item.originalAuthorHandle ? `@${item.originalAuthorHandle}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <article className="discovery-card creator-content-card">
      <div className="discovery-card__topline">
        <div className="creator-content-card__labels">
          <span className={`classification classification--${item.kind}`}>{discoveryKindLabels[item.kind]}</span>
          <span className="creator-content-type">{creatorContentTypeLabels[item.contentType]}</span>
          <span className={`archive-state ${item.feedEligible ? 'archive-state--eligible' : ''}`}>
            {item.feedEligible ? '已进入发现' : '仅博主档案'}
          </span>
        </div>
        <div className="discovery-card__meta">
          <span>{item.platform}</span>
          <span className="meta"><Clock3 size={14} />{new Date(item.publishedAt ?? item.discoveredAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
      {author && <div className="source-author">{author}</div>}
      <h2>{item.title}</h2>
      <p>{item.summary}</p>
      {item.feedEligible && (
        <p className="discovery-card__reason"><strong>推荐理由</strong>{item.reason}</p>
      )}
      {item.contentType === 'repost' && (originalAuthor || item.originalContentUrl) && (
        <div className="creator-content-context">
          <strong>转发原帖</strong>
          {originalAuthor && <span>{originalAuthor}</span>}
          {item.originalContentUrl && <a href={item.originalContentUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />查看原帖</a>}
        </div>
      )}
      {item.contentType === 'reply' && (item.parentContentText || item.parentContentUrl) && (
        <div className="creator-content-context">
          <strong>回复原帖</strong>
          {item.parentContentText && <blockquote>{item.parentContentText}</blockquote>}
          {item.parentContentUrl && <a href={item.parentContentUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />查看原帖</a>}
        </div>
      )}
      <div className="discovery-card__footer">
        <div className="source-links">
          {item.sourceUrls.map((url) => <a key={url} className="text-link" href={url} target="_blank" rel="noreferrer noopener"><ExternalLink size={15} />查看原文</a>)}
        </div>
      </div>
    </article>
  );
}

function CreatorItemsPage() {
  const { id = '' } = useParams();
  const creators = useQuery({ queryKey: ['creators'], queryFn: api.creators });
  const items = useQuery({
    queryKey: ['creator-items', id],
    queryFn: () => api.creatorItems(id),
    enabled: Boolean(id),
  });
  const creator = creators.data?.find((candidate) => candidate.id === id);
  return (
    <Page
      title={creator?.displayName ?? '博主内容'}
      description="该账号已同步的全部有效公开内容"
      action={<Link className="button button--secondary" to="/creators"><ChevronLeft size={16} />返回关注列表</Link>}
    >
      {creator && (
        <div className="creator-archive-summary">
          <span>{creatorPlatformLabels[creator.platform]}</span>
          <a href={creator.profileUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />打开账号主页</a>
        </div>
      )}
      <QueryState isLoading={items.isLoading} error={items.error} retry={() => void items.refetch()} />
      {items.data?.length === 0 && <div className="state"><Inbox />该博主还没有已同步的公开内容</div>}
      <div className="creator-content-list">
        {(items.data ?? []).map((item) => <CreatorContentCard key={item.id} item={item} />)}
      </div>
    </Page>
  );
}

function CreatorCandidateRow({
  candidate,
  selected,
  onChange,
}: {
  candidate: CreatorIdentityCandidate;
  selected: boolean;
  onChange: (selected: boolean) => void;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);

  return (
    <article className={`creator-candidate ${selected ? 'creator-candidate--selected' : ''}`}>
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={`选择 ${candidate.displayName} ${creatorPlatformLabels[candidate.platform]}`}
      />
      {candidate.avatarUrl && !avatarFailed
        ? <img
            src={candidate.avatarUrl}
            alt=""
            width={44}
            height={44}
            referrerPolicy="no-referrer"
            onError={() => setAvatarFailed(true)}
          />
        : <div className="creator-candidate__avatar" aria-hidden="true">
          {candidate.platform === 'rss' ? <Rss size={20} /> : <UserSearch size={20} />}
        </div>}
      <div className="creator-candidate__identity">
        <div>
          <strong>{candidate.displayName}</strong>
          {candidate.verified && <BadgeCheck size={15} aria-label="平台认证" />}
          <span>{creatorPlatformLabels[candidate.platform]}</span>
        </div>
        {candidate.handle && <small>{candidate.handle}</small>}
        {candidate.bio && <p>{candidate.bio}</p>}
        <a href={candidate.profileUrl} target="_blank" rel="noreferrer noopener">
          <ExternalLink size={13} />{candidate.profileUrl}
        </a>
      </div>
    </article>
  );
}

function CreatorsPage() {
  const client = useQueryClient();
  const [input, setInput] = useState('');
  const [candidates, setCandidates] = useState<CreatorIdentityCandidate[]>([]);
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [hasResolved, setHasResolved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const creators = useQuery({
    queryKey: ['creators'],
    queryFn: api.creators,
    refetchInterval: (query) => query.state.data?.some((creator) => isRunActive(creator.runStatus)) ? 1_500 : false,
  });
  const platforms = useQuery({
    queryKey: ['creator-platforms'],
    queryFn: api.creatorPlatforms,
  });
  const refreshData = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['creators'] }),
      client.invalidateQueries({ queryKey: ['feed'] }),
    ]);
  };
  const resolveCreators = useMutation({
    mutationFn: api.resolveCreators,
    onSuccess: ({ candidates: resolved }) => {
      setCandidates(resolved);
      setSelectedTokens(resolved.length === 1 ? [resolved[0]!.resolutionToken] : []);
      setHasResolved(true);
      setFormError(null);
    },
    onError: (error: Error) => {
      setCandidates([]);
      setSelectedTokens([]);
      setHasResolved(true);
      setFormError(error.message);
    },
  });
  const createCreators = useMutation({
    mutationFn: api.createCreators,
    onSuccess: async () => {
      setInput('');
      setCandidates([]);
      setSelectedTokens([]);
      setHasResolved(false);
      setFormError(null);
      await refreshData();
    },
    onError: (error: Error) => setFormError(error.message),
  });
  const refreshCreator = useMutation({
    mutationFn: api.refreshCreator,
    onSuccess: refreshData,
  });
  const updateCreator = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => api.updateCreator(id, { paused }),
    onSuccess: refreshData,
  });
  const deleteCreator = useMutation({
    mutationFn: api.deleteCreator,
    onSuccess: refreshData,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    setFormError(null);
    resolveCreators.mutate({ input: value });
  };
  const confirm = () => {
    if (selectedTokens.length === 0) return;
    setFormError(null);
    createCreators.mutate({ resolutionTokens: selectedTokens });
  };
  const toggleCandidate = (token: string, selected: boolean) => {
    setSelectedTokens((current) => selected
      ? [...current, token]
      : current.filter((candidateToken) => candidateToken !== token));
  };
  const pendingId = refreshCreator.isPending
    ? refreshCreator.variables
    : updateCreator.isPending
      ? updateCreator.variables?.id ?? null
      : deleteCreator.isPending
        ? deleteCreator.variables
        : null;

  return (
    <Page title="博主关注" description="查找并确认公开账号，每日同步新内容">
      <form className="topic-create" onSubmit={submit}>
        <label htmlFor="creator-input">博主或主页</label>
        <input id="creator-input" required maxLength={500} placeholder="名字、Handle 或公开主页 URL" value={input} onChange={(event) => setInput(event.target.value)} />
        <button className="button" type="submit" disabled={resolveCreators.isPending || createCreators.isPending || !input.trim()}>
          {resolveCreators.isPending ? <RefreshCw className="spin" size={16} /> : <UserSearch size={16} />}查找
        </button>
      </form>
      {formError && <p className="inline-error"><AlertCircle size={14} />{formError}</p>}
      {hasResolved && candidates.length === 0 && !formError && (
        <div className="creator-resolution-empty"><Search size={18} />未找到匹配账号</div>
      )}
      {candidates.length > 0 && (
        <section className="creator-candidates" aria-label="账号候选">
          <header><div><h2>确认账号</h2><span>{candidates.length} 个候选</span></div>
            <button className="button" type="button" onClick={confirm} disabled={createCreators.isPending || selectedTokens.length === 0}>
              {createCreators.isPending ? <RefreshCw className="spin" size={16} /> : <Plus size={16} />}
              关注{selectedTokens.length > 0 ? ` ${selectedTokens.length}` : ''}
            </button>
          </header>
          <div className="creator-candidate-list">
            {candidates.map((candidate) => <CreatorCandidateRow
              key={candidate.resolutionToken}
              candidate={candidate}
              selected={selectedTokens.includes(candidate.resolutionToken)}
              onChange={(selected) => toggleCandidate(candidate.resolutionToken, selected)}
            />)}
          </div>
        </section>
      )}
      {!creators.data && <QueryState isLoading={creators.isLoading} error={creators.error} retry={() => void creators.refetch()} />}
      {creators.data?.length === 0 && <div className="state"><Rss />还没有关注博主</div>}
      <div className="topic-list">
        {(creators.data ?? []).map((creator) => (
          <CreatorRow
            key={creator.id}
            creator={creator}
            pending={pendingId === creator.id}
            onRefresh={() => refreshCreator.mutate(creator.id)}
            onTogglePaused={() => updateCreator.mutate({ id: creator.id, paused: !creator.pausedAt })}
            onDelete={() => deleteCreator.mutate(creator.id)}
          />
        ))}
      </div>
      <section className="source-status-section">
        <header><h2>关注平台</h2><span>{platforms.data?.filter((platform) => platform.status === 'enabled').length ?? 0} 个可用</span></header>
        <QueryState isLoading={platforms.isLoading} error={platforms.error} retry={() => void platforms.refetch()} />
        <div className="source-status-list">
          {(platforms.data ?? []).map((platform: CreatorPlatformStatus) => (
            <div className="source-status-row" key={platform.id}>
              <div><strong>{platform.label}</strong><span>博主关注</span></div>
              <span className={`source-state source-state--${platform.status}`}>
                {platform.status === 'enabled' ? <CheckCircle2 size={15} /> : <CircleDashed size={15} />}
                {platform.status === 'enabled' ? '可用' : '未配置'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </Page>
  );
}

const interestSourceLabels: Record<InterestMemoryTheme['sources'][number], string> = {
  keyword: '关键词',
  creator: '博主',
  feedback: '主动反馈',
};

function InterestThemeSection({
  title,
  themes,
  pendingId,
  onForget,
}: {
  title: string;
  themes: InterestMemoryTheme[];
  pendingId: string | null;
  onForget: (id: string) => void;
}) {
  return (
    <section className="interest-group">
      <header><h2>{title}</h2><span>{themes.length}</span></header>
      {themes.length === 0
        ? <p className="interest-empty">暂无主题</p>
        : <div className="interest-theme-list">{themes.map((theme) => (
            <div className="interest-theme" key={theme.id}>
              <div className="interest-theme__main">
                <strong>{theme.name}</strong>
                <div className="interest-theme__meta">
                  {theme.sources.map((source) => <span key={source}>{interestSourceLabels[source]}</span>)}
                  <time dateTime={theme.updatedAt}>{new Date(theme.updatedAt).toLocaleDateString('zh-CN')}</time>
                </div>
              </div>
              <button
                className="icon-button"
                type="button"
                title="忘记主题"
                aria-label={`忘记兴趣主题 ${theme.name}`}
                disabled={pendingId !== null}
                onClick={() => onForget(theme.id)}
              >{pendingId === theme.id
                ? <RefreshCw className="spin" size={17} />
                : <EyeOff size={17} />}</button>
            </div>
          ))}</div>}
    </section>
  );
}

function InterestsPage() {
  const client = useQueryClient();
  const [confirmingClear, setConfirmingClear] = useState(false);
  const interests = useQuery({ queryKey: ['interests'], queryFn: api.interests });
  const updateCached = (data: InterestMemory) => {
    client.setQueryData(['interests'], data);
    void client.invalidateQueries({ queryKey: ['feed'] });
  };
  const settings = useMutation({
    mutationFn: api.setInterestSettings,
    onSuccess: updateCached,
  });
  const forget = useMutation({
    mutationFn: api.forgetInterest,
    onSuccess: updateCached,
  });
  const clear = useMutation({
    mutationFn: api.clearInterestHistory,
    onSuccess: (data) => {
      updateCached(data);
      setConfirmingClear(false);
    },
  });
  const mutationError = settings.error ?? forget.error ?? clear.error;

  return (
    <Page title="兴趣记忆" description="近期兴趣、长期兴趣与减少推荐">
      {!interests.data && (
        <QueryState
          isLoading={interests.isLoading}
          error={interests.error}
          retry={() => void interests.refetch()}
        />
      )}
      {mutationError && <p className="inline-error"><AlertCircle size={15} />{mutationError.message}</p>}
      {interests.data && <>
        <section className="interest-settings">
          <div><h2>个性化排序</h2><p>{interests.data.personalizationEnabled ? '已开启' : '已暂停'}</p></div>
          <label className="toggle-control">
            <input
              type="checkbox"
              aria-label="个性化排序"
              checked={interests.data.personalizationEnabled}
              disabled={settings.isPending}
              onChange={(event) => settings.mutate({ personalizationEnabled: event.target.checked })}
            />
            <span aria-hidden="true" />
          </label>
          <button
            className="button button--secondary interest-clear"
            type="button"
            onClick={() => setConfirmingClear(true)}
          ><Trash2 size={16} />清空历史</button>
        </section>
        <div className="interest-groups">
          <InterestThemeSection
            title="近期兴趣"
            themes={interests.data.recent}
            pendingId={forget.isPending ? forget.variables : null}
            onForget={(id) => forget.mutate(id)}
          />
          <InterestThemeSection
            title="长期兴趣"
            themes={interests.data.longTerm}
            pendingId={forget.isPending ? forget.variables : null}
            onForget={(id) => forget.mutate(id)}
          />
          <InterestThemeSection
            title="减少推荐"
            themes={interests.data.reduced}
            pendingId={forget.isPending ? forget.variables : null}
            onForget={(id) => forget.mutate(id)}
          />
        </div>
        {confirmingClear && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-label="清空兴趣历史确认">
          <h3>清空兴趣历史？</h3><p>主动反馈和博主内容形成的兴趣会重新学习，正在关注的关键词仍会保留。</p>
          <div><button className="text-button" disabled={clear.isPending} onClick={() => setConfirmingClear(false)}>取消</button><button className="button button--danger" autoFocus disabled={clear.isPending} onClick={() => clear.mutate()}>{clear.isPending && <RefreshCw className="spin" size={16} />}确认清空</button></div>
        </div></div>}
      </>}
    </Page>
  );
}

function DigestPage() {
  const client = useQueryClient();
  const preference = useQuery({
    queryKey: ['digest-preference'], queryFn: api.digestPreference,
  });
  const preview = useQuery({ queryKey: ['digest-preview'], queryFn: api.digestPreview });
  const status = useQuery({ queryKey: ['digest-status'], queryFn: api.digestStatus });
  const [draft, setDraft] = useState<DigestPreference | null>(null);
  useEffect(() => {
    if (preference.data) setDraft(preference.data);
  }, [preference.data]);
  const save = useMutation({
    mutationFn: api.setDigestPreference,
    onSuccess: (data) => {
      client.setQueryData(['digest-preference'], data);
      setDraft(data);
      void client.invalidateQueries({ queryKey: ['digest-status'] });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft) save.mutate(draft);
  };

  return (
    <Page title="每日邮件" description="设置本地发送时间并预览下一封引用型研究简报">
      <DigestDeliveryStatusView
        status={status.data}
        loading={status.isLoading}
        error={status.error}
        retry={() => void status.refetch()}
      />
      {!draft && (
        <QueryState
          isLoading={preference.isLoading}
          error={preference.error}
          retry={() => void preference.refetch()}
        />
      )}
      {save.error && <p className="inline-error"><AlertCircle size={15} />{save.error.message}</p>}
      {draft && <form className="digest-settings" onSubmit={submit}>
        <div className="digest-settings__toggle">
          <div><h2>每日邮件</h2><p>{draft.enabled ? '已开启' : '已暂停'}</p></div>
          <label className="toggle-control">
            <input
              type="checkbox"
              aria-label="每日邮件"
              checked={draft.enabled}
              disabled={save.isPending}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            <span aria-hidden="true" />
          </label>
        </div>
        <label className="digest-field">
          <span>发送时间</span>
          <input
            type="time"
            aria-label="发送时间"
            value={draft.localTime}
            disabled={save.isPending}
            onChange={(event) => setDraft({ ...draft, localTime: event.target.value })}
          />
        </label>
        <label className="digest-field">
          <span>时区</span>
          <select
            aria-label="时区"
            value={draft.timezone}
            disabled={save.isPending}
            onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
          >
            {!timeZones.includes(draft.timezone) && (
              <option value={draft.timezone}>{draft.timezone}</option>
            )}
            {timeZones.map((timezone) => <option value={timezone} key={timezone}>{timezone}</option>)}
          </select>
        </label>
        <button className="button" type="submit" disabled={save.isPending}>
          {save.isPending ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}
          保存设置
        </button>
      </form>}

      <DigestRunStatusView
        run={status.data?.recentRun}
        loading={status.isLoading}
        error={status.error}
        retry={() => void status.refetch()}
      />

      <section className="digest-preview">
        <header>
          <div><h2>下一封邮件预览</h2><span>{preview.data?.items.length ?? 0} / 10</span></div>
          <button
            className="icon-button"
            type="button"
            title="刷新邮件预览"
            aria-label="刷新邮件预览"
            disabled={preview.isFetching}
            onClick={() => void preview.refetch()}
          ><RefreshCw className={preview.isFetching ? 'spin' : undefined} size={17} /></button>
        </header>
        {!preview.data && (
          <QueryState
            isLoading={preview.isLoading}
            error={preview.error}
            retry={() => void preview.refetch()}
          />
        )}
        {preview.data?.items.length === 0 && (
          <div className="state digest-preview__empty"><Inbox />暂无符合条件的新内容</div>
        )}
        {preview.data && preview.data.items.length > 0 && (
          <div className="digest-preview-list">{preview.data.items.map((item) => (
            <article className="digest-preview-item" key={item.contentKey}>
              <h3>{item.title}</h3>
              <p><strong>结论</strong>{item.brief.conclusion}</p>
              <p><strong>证据</strong>{item.brief.evidence}</p>
              <p><strong>不确定性</strong>{item.brief.uncertainty}</p>
              <p><strong>后续关注</strong>{item.brief.followUp}</p>
              <div className="digest-preview-item__citations">
                {item.citations.map((citation) => (
                  <a href={citation.url} target="_blank" rel="noreferrer noopener" key={citation.url}>
                    <ExternalLink size={15} />
                    {citation.platform}{citation.publishedAt
                      ? ` · ${new Date(citation.publishedAt).toLocaleDateString('zh-CN')}`
                      : ''}
                  </a>
                ))}
              </div>
            </article>
          ))}</div>
        )}
      </section>
    </Page>
  );
}

function DigestDeliveryStatusView({
  status,
  loading,
  error,
  retry,
}: {
  status: DigestStatus | undefined;
  loading: boolean;
  error: Error | null;
  retry: () => void;
}) {
  return <section className="digest-delivery-status">
    <header><h2>投递能力</h2></header>
    {!status && <QueryState isLoading={loading} error={error} retry={retry} />}
    {status && <div className="digest-delivery-status__row">
      <span className={`digest-delivery-status__state digest-delivery-status__state--${status.deliveryCapability}`}>
        {status.deliveryCapability === 'configured' ? '已配置' : '未配置'}
      </span>
      {status.deliveryCapability === 'not_configured' && (
        <span>服务器尚未配置邮件服务，当前不会创建发送任务</span>
      )}
      {status.nextLocalSend && (
        <span>下次发送：{status.nextLocalSend.localDate} {status.nextLocalSend.localTime}（{status.nextLocalSend.timezone}）</span>
      )}
    </div>}
  </section>;
}

const digestRunLabels: Record<NonNullable<DigestRecentRun>['status'], string> = {
  queued: '等待发送',
  running: '正在发送',
  succeeded: '已发送',
  skipped: '无内容，已跳过',
  failed: '发送失败',
};

function DigestRunStatusView({
  run,
  loading,
  error,
  retry,
}: {
  run: DigestRecentRun | undefined;
  loading: boolean;
  error: Error | null;
  retry: () => void;
}) {
  return <section className="digest-run-status">
    <header><h2>最近运行</h2></header>
    {run === undefined && <QueryState isLoading={loading} error={error} retry={retry} />}
    {run === null && <div className="digest-run-status__empty">尚无运行记录</div>}
    {run && <div className="digest-run-status__row">
      <span className={`digest-run-status__state digest-run-status__state--${run.status}`}>
        {digestRunLabels[run.status]}
      </span>
      <span>{run.scheduledLocalDate}</span>
      <span>{run.itemCount} 条内容</span>
      {run.finishedAt && <time dateTime={run.finishedAt}>{new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).format(new Date(run.finishedAt))}</time>}
    </div>}
  </section>;
}

function ItemPage() {
  const { id = '' } = useParams();
  const item = useQuery({ queryKey: ['item', id], queryFn: () => api.item(id) });
  return (
    <Page title="发现详情" description="AI 中文摘要、推荐理由与引用原文">
      <QueryState isLoading={item.isLoading} error={item.error} retry={() => void item.refetch()} />
      {item.data && <article className="item-detail">
        <span className={`classification classification--${item.data.kind}`}>{discoveryKindLabels[item.data.kind]}</span>
        <h2>{item.data.title}</h2>
        <section><h3>中文摘要</h3><p>{item.data.summary}</p></section>
        <section><h3>推荐理由</h3><p>{item.data.reason}</p></section>
        <section className="item-sources"><h3>原始来源</h3>{item.data.sourceUrls.map((url) => (
          <a href={url} target="_blank" rel="noreferrer noopener" key={url}><ExternalLink size={16} /><span>{url}</span><ChevronRight size={16} /></a>
        ))}</section>
      </article>}
    </Page>
  );
}

function Page({
  title,
  description,
  action,
  containerProps,
  children,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  containerProps?: ReturnType<typeof usePullRefresh>['containerProps'];
  children: React.ReactNode;
}) {
  return <main className="page" {...containerProps}><header className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{action}</header>{children}</main>;
}

function AuthPage({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const authenticate = useMutation({
    mutationFn: () => mode === 'login'
      ? api.login({ email, password })
      : api.register({ email, password, timezone }),
    onSuccess: onAuthenticated,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    authenticate.mutate();
  };

  return <main className="auth-page">
    <section className="auth-panel" aria-labelledby="auth-title">
      <div className="auth-brand"><span>LM</span><h1 id="auth-title">LetterMate</h1></div>
      <div className="auth-tabs" role="tablist" aria-label="账户操作">
        <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>登录</button>
        <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => setMode('register')}>注册</button>
      </div>
      <form onSubmit={submit}>
        <label><span>邮箱</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label><span>密码</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {mode === 'register' && <label><span>时区</span><select value={timezone} onChange={(event) => setTimezone(event.target.value)}>{timeZones.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>}
        {authenticate.error && <p className="inline-error"><AlertCircle size={15} />{authenticate.error.message}</p>}
        <button className="button auth-submit" type="submit" disabled={authenticate.isPending}>
          {authenticate.isPending ? <RefreshCw className="spin" size={17} /> : mode === 'login' ? <LogIn size={17} /> : <UserPlus size={17} />}
          {mode === 'login' ? '登录' : '创建账户'}
        </button>
      </form>
    </section>
  </main>;
}

function Workspace({ session, onLogout }: { session: AuthSession; onLogout: () => void }) {
  const [mobileMenu, setMobileMenu] = useState(false);
  const sources = useDiscoverySources();
  const enabledSourceCount = sources.data?.filter((source) => source.status === 'enabled').length ?? 0;
  return <div className="shell">
    <aside className={`sidebar ${mobileMenu ? 'sidebar--open' : ''}`}>
      <div className="brand"><span>LM</span><div><strong>LetterMate</strong><small>AI 信息发现工作台</small></div></div>
      <nav>{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setMobileMenu(false)}><Icon size={19} />{label}</NavLink>)}</nav>
      <div className="sidebar-note"><span className="live-dot" /><div><strong>多源发现</strong><small>{enabledSourceCount} 个来源已启用</small></div></div>
      {session.user && <div className="sidebar-account"><div><strong>{session.user.email}</strong><small>{session.user.timezone}</small></div>{session.csrfToken && <button className="icon-button" type="button" title="退出登录" aria-label="退出登录" onClick={onLogout}><LogOut size={17} /></button>}</div>}
    </aside>
    <div className="workspace">
      <header className="mobile-header"><button className="icon-button" title="菜单" aria-label="菜单" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={20} /></button><strong>LetterMate</strong><span className="live-dot" /></header>
      <Routes><Route path="/" element={<FeedPage />} /><Route path="/topics" element={<TopicsPage />} /><Route path="/creators" element={<CreatorsPage />} /><Route path="/creators/:id" element={<CreatorItemsPage />} /><Route path="/interests" element={<InterestsPage />} /><Route path="/digest" element={<DigestPage />} /><Route path="/items/:id" element={<ItemPage />} /></Routes>
    </div>
    <nav className="bottom-nav">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={19} /><span>{label}</span></NavLink>)}</nav>
  </div>;
}

export default function App() {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ['auth-session'],
    queryFn: api.session,
    retry: false,
    // Keep the existing development workspace responsive while the real
    // session endpoint is checked in the background.
    ...(import.meta.env.DEV ? {
      initialData: {
        authenticated: true,
        user: { id: 'user-a', email: 'user-a@example.local', timezone: 'Asia/Shanghai' },
        csrfToken: null,
      } satisfies AuthSession,
    } : {}),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => client.setQueryData<AuthSession>(['auth-session'], {
      authenticated: false, user: null, csrfToken: null,
    }),
  });
  if (!session.data) {
    return <main className="auth-page"><QueryState isLoading={session.isLoading} error={session.error} retry={() => void session.refetch()} /></main>;
  }
  if (!session.data.authenticated || !session.data.user) {
    return <AuthPage onAuthenticated={(value) => client.setQueryData(['auth-session'], value)} />;
  }
  return <Workspace session={session.data} onLogout={() => logout.mutate()} />;
}
