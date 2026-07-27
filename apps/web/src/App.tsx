import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DiscoveryKind,
  DiscoverySourceStatus,
  FeedRange,
  SourceType,
  Topic,
} from '@lettermate/contracts';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  ExternalLink,
  Inbox,
  Menu,
  Newspaper,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Route, Routes, useParams } from 'react-router-dom';
import { api } from './api.js';
import { DiscoveryCard } from './components/DiscoveryCard.js';

const navigation = [
  { to: '/', label: '发现', icon: Newspaper },
  { to: '/topics', label: '主题', icon: Search },
];

const statusLabel: Record<Topic['runStatus'], string> = {
  queued: '等待多源发现',
  running: '多源发现中',
  succeeded: '已完成',
  failed: '失败',
};

const sourceTypeLabel: Record<SourceType, string> = {
  web: '网页',
  feed: '订阅',
  social: '社交',
  video: '视频',
  community: '社区',
  code: '代码',
  paper: '论文',
};

function useTopics() {
  return useQuery({
    queryKey: ['topics'],
    queryFn: api.topics,
    refetchInterval: (query) => query.state.data?.some((topic) =>
      topic.runStatus === 'queued' || topic.runStatus === 'running') ? 1_500 : false,
  });
}

function useDiscoverySources() {
  return useQuery({ queryKey: ['discovery-sources'], queryFn: api.discoverySources });
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

function FeedPage() {
  const topics = useTopics();
  const [kind, setKind] = useState<DiscoveryKind | 'all'>('all');
  const [range, setRange] = useState<FeedRange>('recent');
  const [topicId, setTopicId] = useState('');
  const filter = {
    range,
    ...(topicId ? { topicId } : {}),
    ...(kind === 'all' ? {} : { kind }),
  };
  const feed = useQuery({
    queryKey: ['feed', filter],
    queryFn: () => api.feed(filter),
  });

  return (
    <Page title="发现" description="从搜索、社交、视频与技术社区汇集高价值新内容" action={
      <button className="icon-button" title="刷新发现" aria-label="刷新发现" onClick={() => void feed.refetch()}><RefreshCw size={18} /></button>
    }>
      <div className="feed-tools">
        <div className="feed-segments">
          <div className="segmented" aria-label="发现分类">
            {([['all', '全部'], ['hot', '热点'], ['quality', '优质']] as const).map(([value, label]) => (
              <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>
            ))}
          </div>
          <div className="segmented segmented--history" aria-label="历史范围">
            <button aria-pressed={range === 'recent'} onClick={() => setRange('recent')}>最近 90 天</button>
            <button aria-pressed={range === 'all'} onClick={() => setRange('all')}>全部历史</button>
          </div>
        </div>
        <label className="topic-filter">
          <span>主题</span>
          <select value={topicId} onChange={(event) => setTopicId(event.target.value)}>
            <option value="">全部主题</option>
            {(topics.data ?? []).map((topic) => <option key={topic.id} value={topic.id}>{topic.keyword}</option>)}
          </select>
        </label>
      </div>
      <TopicErrors topics={topics.data ?? []} />
      {!topics.data && <QueryState isLoading={topics.isLoading} error={topics.error} retry={() => void topics.refetch()} />}
      {!feed.data && <QueryState isLoading={feed.isLoading} error={feed.error} retry={() => void feed.refetch()} />}
      {feed.data?.length === 0 && <div className="state"><Inbox />暂无发现内容</div>}
      <div className="discovery-list">
        {(feed.data ?? []).map((item) => <DiscoveryCard key={item.id} item={item} detailHref={`/items/${item.id}`} />)}
      </div>
    </Page>
  );
}

function TopicsPage() {
  const client = useQueryClient();
  const topics = useTopics();
  const sources = useDiscoverySources();
  const [keyword, setKeyword] = useState('');
  const create = useMutation({
    mutationFn: api.createTopic,
    onSuccess: (topic) => {
      client.setQueryData<Topic[]>(['topics'], (current = []) => [topic, ...current.filter((item) => item.id !== topic.id)]);
      setKeyword('');
    },
  });
  const refresh = useMutation({
    mutationFn: api.refreshTopic,
    onSuccess: (topic) => client.setQueryData<Topic[]>(['topics'], (current = []) =>
      current.map((item) => item.id === topic.id ? topic : item)),
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (keyword.trim()) create.mutate({ keyword });
  };

  return (
    <Page title="主题" description="输入关键词后自动扩展中英文查询，并按计划持续更新">
      <form className="topic-create" onSubmit={submit}>
        <label htmlFor="topic-keyword">主题关键词</label>
        <input id="topic-keyword" value={keyword} maxLength={100} onChange={(event) => setKeyword(event.target.value)} placeholder="例如：AI Agent" />
        <button className="button" disabled={create.isPending || !keyword.trim()}><Plus size={17} />创建主题</button>
      </form>
      {create.error && <div className="error-banner"><AlertCircle size={18} /><span>{create.error.message}</span></div>}
      {!topics.data && <QueryState isLoading={topics.isLoading} error={topics.error} retry={() => void topics.refetch()} />}
      <div className="topic-list">
        {(topics.data ?? []).map((topic) => (
          <article className="topic-row" key={topic.id}>
            <div className="topic-row__main">
              <div className="topic-row__title"><h2>{topic.keyword}</h2><span className={`run-state run-state--${topic.runStatus}`}>{statusLabel[topic.runStatus]}</span></div>
              <p className="topic-schedule"><Clock3 size={14} />{topic.nextRunAt
                ? `下次自动更新 ${new Date(topic.nextRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 每 ${topic.scheduleIntervalHours} 小时`
                : `每 ${topic.scheduleIntervalHours} 小时 · 等待首次自动更新`}</p>
              {topic.expandedTerms.length > 0 && <div className="term-list" aria-label="AI 扩展词">{topic.expandedTerms.map((term) => <span key={term}>{term}</span>)}</div>}
              {topic.lastError && <p className="inline-error"><AlertCircle size={15} />{topic.lastError.message}</p>}
            </div>
            <button className="icon-button" title="重新搜索" aria-label={`刷新 ${topic.keyword}`} disabled={refresh.isPending} onClick={() => refresh.mutate(topic.id)}><RefreshCw size={17} /></button>
          </article>
        ))}
        {topics.data?.length === 0 && <div className="state"><Search />尚未创建主题</div>}
      </div>
      <section className="source-status-section">
        <header><h2>信息来源</h2><span>{sources.data?.filter((source) => source.status === 'enabled').length ?? 0} 个已启用</span></header>
        <QueryState isLoading={sources.isLoading} error={sources.error} retry={() => void sources.refetch()} />
        <div className="source-status-list">
          {(sources.data ?? []).map((source: DiscoverySourceStatus) => (
            <div className="source-status-row" key={source.id}>
              <div><strong>{source.label}</strong><span>{sourceTypeLabel[source.category]}</span></div>
              <span className={`source-state source-state--${source.status}`}>
                {source.status === 'enabled' ? <CheckCircle2 size={15} /> : <CircleDashed size={15} />}
                {source.status === 'enabled' ? '已启用' : '待配置'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </Page>
  );
}

function ItemPage() {
  const { id = '' } = useParams();
  const item = useQuery({ queryKey: ['item', id], queryFn: () => api.item(id) });
  return (
    <Page title="发现详情" description="AI 中文摘要、推荐理由与引用原文">
      <QueryState isLoading={item.isLoading} error={item.error} retry={() => void item.refetch()} />
      {item.data && <article className="item-detail">
        <span className={`classification classification--${item.data.kind}`}>{item.data.kind === 'hot' ? '热点' : '优质'}</span>
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

function Page({ title, description, action, children }: { title: string; description: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <main className="page"><header className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{action}</header>{children}</main>;
}

export default function App() {
  const [mobileMenu, setMobileMenu] = useState(false);
  const sources = useDiscoverySources();
  const enabledSourceCount = sources.data?.filter((source) => source.status === 'enabled').length ?? 0;
  return <div className="shell">
    <aside className={`sidebar ${mobileMenu ? 'sidebar--open' : ''}`}>
      <div className="brand"><span>LM</span><div><strong>LetterMate</strong><small>AI 信息发现工作台</small></div></div>
      <nav>{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setMobileMenu(false)}><Icon size={19} />{label}</NavLink>)}</nav>
      <div className="sidebar-note"><span className="live-dot" /><div><strong>多源发现</strong><small>{enabledSourceCount} 个来源已启用</small></div></div>
    </aside>
    <div className="workspace">
      <header className="mobile-header"><button className="icon-button" title="菜单" aria-label="菜单" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={20} /></button><strong>LetterMate</strong><span className="live-dot" /></header>
      <Routes><Route path="/" element={<FeedPage />} /><Route path="/topics" element={<TopicsPage />} /><Route path="/items/:id" element={<ItemPage />} /></Routes>
    </div>
    <nav className="bottom-nav">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={19} /><span>{label}</span></NavLink>)}</nav>
  </div>;
}
