// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DiscoverySourceStatus,
  FeedItem,
  RunSummary,
  Topic,
  TrendStatus,
} from '@lettermate/contracts';
import App from './App.js';
import './test-setup.js';

const now = new Date();

function runSummary(
  id: string,
  status: RunSummary['status'],
  newItemCount: number | null = null,
): RunSummary {
  const base = {
    id,
    trigger: 'manual' as const,
    startedAt: new Date(now.getTime() - 60_000).toISOString(),
  };
  if (status === 'queued' || status === 'running') {
    return { ...base, status, finishedAt: null, newItemCount: null };
  }
  if (status === 'failed') {
    return { ...base, status, finishedAt: now.toISOString(), newItemCount: null };
  }
  return { ...base, status, finishedAt: now.toISOString(), newItemCount: newItemCount ?? 0 };
}

function topic(id: string, keyword: string, lastRun: RunSummary | null = null): Topic {
  return {
    id,
    userId: 'user-a',
    keyword,
    expandedTerms: [`${keyword} news`],
    createdAt: new Date(now.getTime() - 86_400_000).toISOString(),
    lastRunAt: lastRun?.startedAt ?? null,
    nextRunAt: new Date(now.getTime() + 43_200_000).toISOString(),
    scheduleIntervalHours: 12,
    runStatus: lastRun?.status ?? 'succeeded',
    lastError: null,
    lastRun,
  };
}

function feedItem(
  id: string,
  origin: FeedItem['origin'],
  ageInDays = 0,
  topicId = 'topic-1',
): FeedItem {
  const common = {
    id,
    kind: 'quality' as const,
    title: `发现 ${id}`,
    summary: '中文摘要',
    reason: '内容深入',
    sourceUrls: [`https://example.com/${id}`],
    publishedAt: null,
    discoveredAt: new Date(now.getTime() - ageInDays * 86_400_000).toISOString(),
    sourceType: 'web' as const,
    platform: 'Example',
    authorName: 'Project Team',
    authorHandle: 'project',
    externalId: id,
    provenanceKind: 'api_record' as const,
  };
  return origin === 'topic'
    ? { ...common, origin, topicId, topicKeyword: 'gpt-5.7', topicKeywordActive: true }
    : { ...common, origin, topicId: null };
}

const initialTrendStatus: TrendStatus = {
  runStatus: 'succeeded',
  nextRunAt: new Date(now.getTime() + 14_400_000).toISOString(),
  intervalHours: 4,
  lastError: null,
  lastRun: null,
};

const requests: Array<{ url: string; method: string; body?: unknown }> = [];

interface FetchMockOptions {
  topics?: Topic[];
  topicsResponse?: Promise<Topic[]>;
  feed?: FeedItem[];
  feedByQuery?: Record<string, FeedItem[]>;
  feedSearchFailures?: number;
  item?: FeedItem;
  created?: Topic;
  createdResponse?: Promise<Topic>;
  createFailure?: boolean;
  sources?: DiscoverySourceStatus[];
  topicCompletionCount?: number;
  trendCompletionCount?: number;
  trendStatusFailures?: number;
  feedRefetchFailures?: number;
  topicCompletionAfterPolls?: number;
  trendStatus?: TrendStatus;
}

function installFetchMock({
  topics: initialTopics = [],
  topicsResponse,
  feed = [],
  feedByQuery = {},
  feedSearchFailures: initialFeedSearchFailures = 0,
  item,
  created,
  createdResponse,
  createFailure = false,
  sources = [],
  topicCompletionCount = 0,
  trendCompletionCount = 0,
  trendStatusFailures: initialTrendStatusFailures = 0,
  feedRefetchFailures: initialFeedRefetchFailures = 0,
  topicCompletionAfterPolls = 1,
  trendStatus: configuredTrendStatus = initialTrendStatus,
}: FetchMockOptions = {}) {
  const refreshedTopicIds = new Set<string>();
  let currentTopics = initialTopics;
  const topicRefreshGenerations = new Map<string, number>();
  let trendRefreshStarted = false;
  let trendStatusFailures = initialTrendStatusFailures;
  let feedRequestCount = 0;
  let feedRefetchFailures = initialFeedRefetchFailures;
  let feedSearchFailures = initialFeedSearchFailures;
  let manualTopicPollCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });

    if (url.endsWith('/topics') && method === 'POST') {
      if (createFailure) {
        return Response.json({ code: 'CREATE_FAILED', message: 'Create failed', traceId: 'test' }, { status: 503 });
      }
      return Response.json(createdResponse ? await createdResponse : created!, { status: 201 });
    }
    const topicUpdateMatch = url.match(/\/topics\/([^/]+)$/);
    if (topicUpdateMatch && method === 'PATCH') {
      const topicId = decodeURIComponent(topicUpdateMatch[1] ?? '');
      const existing = currentTopics.find((candidate) => candidate.id === topicId)!;
      const updated = { ...existing, ...(body as { keyword: string; expandedTerms: string[] }) };
      currentTopics = currentTopics.map((candidate) => candidate.id === topicId ? updated : candidate);
      return Response.json(updated);
    }
    const topicRefreshMatch = url.match(/\/topics\/([^/]+)\/refresh$/);
    if (topicRefreshMatch && method === 'POST') {
      const topicRefreshId = decodeURIComponent(topicRefreshMatch[1] ?? '');
      refreshedTopicIds.add(topicRefreshId);
      const generation = (topicRefreshGenerations.get(topicRefreshId) ?? 0) + 1;
      topicRefreshGenerations.set(topicRefreshId, generation);
      const refreshed = currentTopics.find((item) => item.id === topicRefreshId)!;
      return Response.json({ ...refreshed, lastRun: runSummary(`queued-${topicRefreshId}-${generation}`, 'queued'), runStatus: 'queued' });
    }
    if (url.endsWith('/topics')) {
      const availableTopics = topicsResponse
        ? await topicsResponse
        : currentTopics;
      if (refreshedTopicIds.size > 0) manualTopicPollCount += 1;
      const topicRunTerminal = manualTopicPollCount >= topicCompletionAfterPolls;
      return Response.json(availableTopics.map((item) => refreshedTopicIds.has(item.id)
        ? topicRunTerminal
          ? { ...item, lastRun: runSummary(`done-${item.id}-${topicRefreshGenerations.get(item.id)}`, 'succeeded', topicCompletionCount), runStatus: 'succeeded' }
          : { ...item, lastRun: runSummary(`queued-${item.id}-${topicRefreshGenerations.get(item.id)}`, 'running'), runStatus: 'running' }
        : item));
    }
    if (url.endsWith('/trends/refresh') && method === 'POST') {
      trendRefreshStarted = true;
      return Response.json({ ...initialTrendStatus, runStatus: 'queued', lastRun: runSummary('queued-trend', 'queued') });
    }
    if (url.endsWith('/trends/status')) {
      if (trendStatusFailures > 0) {
        trendStatusFailures -= 1;
        return Response.json({ code: 'TREND_STATUS_UNAVAILABLE', message: '趋势状态暂时不可用', traceId: 'test' }, { status: 503 });
      }
      return Response.json(trendRefreshStarted
        ? { ...configuredTrendStatus, runStatus: 'succeeded', lastRun: runSummary('done-trend', 'succeeded', trendCompletionCount) }
        : configuredTrendStatus);
    }
    if (url.endsWith('/discovery-sources')) return Response.json(sources);
    if (/\/items\/[^/?]+$/.test(url)) return Response.json(item!);
    if (url.includes('/feed')) {
      feedRequestCount += 1;
      const query = new URL(url, 'http://test').searchParams.get('q');
      if (query && feedSearchFailures > 0) {
        feedSearchFailures -= 1;
        return Response.json({
          code: 'FEED_UNAVAILABLE', message: '搜索暂时不可用', traceId: 'test',
        }, { status: 503 });
      }
      if (feedRequestCount > 1 && feedRefetchFailures > 0) {
        feedRefetchFailures -= 1;
        return Response.json({ code: 'FEED_UNAVAILABLE', message: '发现内容暂时不可用', traceId: 'test' }, { status: 503 });
      }
      return Response.json(query ? feedByQuery[query] ?? [] : feed);
    }
    return Response.json({ code: 'NOT_FOUND', message: 'not found', traceId: 'test' }, { status: 404 });
  }));
  return {
    setTopics(nextTopics: Topic[]) {
      currentTopics = nextTopics;
    },
  };
}

function renderApp(route: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

describe('discovery workspace', () => {
  afterEach(() => {
    cleanup();
    requests.length = 0;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('requests the default 30-day range and offers every labeled time option', async () => {
    installFetchMock({ feed: [feedItem('today', 'topic')] });
    renderApp('/');

    const range = await screen.findByRole('combobox', { name: '时间范围' });
    expect(range).toHaveValue('30d');
    expect(within(range).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '近 24 小时', '近 3 天', '近 7 天', '近 30 天', '近 90 天', '全部历史',
    ]);
    await waitFor(() => expect(requests.some(({ url }) => (
      url.includes('/feed?') && url.includes('range=30d')
    ))).toBe(true));

    fireEvent.change(range, { target: { value: '3d' } });
    await waitFor(() => expect(requests.some(({ url }) => url.includes('range=3d'))).toBe(true));
  });

  it('submits search only from the form and keeps it active across Feed filters', async () => {
    installFetchMock({
      feed: [feedItem('normal', 'topic')],
      feedByQuery: { 智能体工程: [feedItem('matched', 'topic')] },
    });
    renderApp('/');
    await screen.findByRole('heading', { name: /normal/ });
    const input = screen.getByLabelText('搜索已获取文章');
    const requestsBeforeTyping = requests.filter(({ url }) => url.includes('/feed')).length;

    fireEvent.change(input, { target: { value: '  智能体工程  ' } });
    expect(requests.filter(({ url }) => url.includes('/feed'))).toHaveLength(requestsBeforeTyping);

    fireEvent.submit(screen.getByRole('search'));
    await screen.findByRole('heading', { name: /matched/ });
    expect(requests.some(({ url }) => {
      const query = new URL(url, 'http://test').searchParams;
      return query.get('q') === '智能体工程'
        && query.get('range') === '30d'
        && query.get('origin') === 'all';
    })).toBe(true);

    fireEvent.change(screen.getByRole('combobox', { name: '时间范围' }), {
      target: { value: '3d' },
    });
    await waitFor(() => expect(requests.some(({ url }) => {
      const query = new URL(url, 'http://test').searchParams;
      return query.get('q') === '智能体工程' && query.get('range') === '3d';
    })).toBe(true));
  });

  it('searches from the icon button and clears back to the normal Feed', async () => {
    installFetchMock({
      feed: [feedItem('normal', 'topic')],
      feedByQuery: { 智能体: [feedItem('matched', 'topic')] },
    });
    renderApp('/');
    await screen.findByRole('heading', { name: /normal/ });

    fireEvent.change(screen.getByLabelText('搜索已获取文章'), {
      target: { value: '智能体' },
    });
    fireEvent.click(screen.getByRole('button', { name: '搜索文章' }));
    await screen.findByRole('heading', { name: /matched/ });

    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    await screen.findByRole('heading', { name: /normal/ });
    expect(requests.at(-1)?.url).not.toContain('q=');
  });

  it('shows search empty state and retains failed context for retry', async () => {
    installFetchMock({
      feed: [feedItem('normal', 'topic')],
      feedByQuery: { 无结果: [], 智能体: [feedItem('matched', 'topic')] },
      feedSearchFailures: 1,
    });
    renderApp('/');
    await screen.findByRole('heading', { name: /normal/ });
    const input = screen.getByLabelText('搜索已获取文章');

    fireEvent.change(input, { target: { value: '无结果' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(await screen.findByText('搜索暂时不可用')).toBeVisible();
    expect(input).toHaveValue('无结果');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('未找到匹配文章')).toBeVisible();

    fireEvent.change(input, { target: { value: '智能体' } });
    fireEvent.submit(screen.getByRole('search'));
    await screen.findByRole('heading', { name: /matched/ });
  });

  it('maps one source selector to valid Feed filters without stale topic IDs', async () => {
    installFetchMock({ topics: [topic('topic-1', 'AI Agent')], feed: [feedItem('today', 'topic')] });
    renderApp('/');

    const source = await screen.findByRole('combobox', { name: '来源' });
    await within(source).findByRole('option', { name: 'AI Agent' });
    expect(within(source).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '全部来源', '全网趋势', 'AI Agent',
    ]);

    fireEvent.change(source, { target: { value: 'topic:topic-1' } });
    await waitFor(() => expect(requests.some(({ url }) => (
      url.includes('/feed?') && url.includes('topicId=topic-1') && url.includes('origin=topic')
    ))).toBe(true));

    fireEvent.change(source, { target: { value: 'trend' } });
    await waitFor(() => expect(requests.some(({ url }) => (
      url.includes('/feed?') && url.includes('origin=trend') && !url.includes('topicId=')
    ))).toBe(true));

    fireEvent.change(source, { target: { value: 'all' } });
    await waitFor(() => {
      const latestFeedRequest = requests.filter(({ url }) => url.includes('/feed?')).at(-1)?.url;
      expect(latestFeedRequest).toContain('origin=all');
      expect(latestFeedRequest).not.toContain('topicId=');
    });
    expect(requests.every(({ url }) => !(url.includes('origin=trend') && url.includes('topicId=')))).toBe(true);
  });

  it('renders nonempty unframed time groups around feed cards', async () => {
    installFetchMock({ feed: [feedItem('today', 'topic'), feedItem('yesterday', 'trend', 1)] });
    renderApp('/');

    expect(await screen.findByRole('heading', { level: 2, name: '今天' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: '昨天' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 3, name: '发现 today' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 3, name: '发现 yesterday' })).toBeVisible();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: '近 3 天' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '今天' }).closest('section')).toHaveClass('feed-time-group');
  });

  it('passes the exact Topic keyword into Topic cards', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent'), topic('topic-2', 'gpt-5.7')],
      feed: [feedItem('today', 'topic', 0, 'topic-2')],
    });
    renderApp('/');

    expect(await screen.findByText('来自「gpt-5.7」')).toBeVisible();
    expect(screen.queryByText('来自「AI Agent」')).not.toBeInTheDocument();
  });

  it('renders quality items as selected on the detail page', async () => {
    installFetchMock({ item: feedItem('detail', 'topic') });
    renderApp('/items/detail');

    expect(await screen.findByText('精选')).toBeVisible();
    expect(screen.queryByText('优质')).not.toBeInTheDocument();
  });

  it('shows active target count and the coordinator completion message for top refresh', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent')],
      feed: [feedItem('today', 'topic')],
      topicCompletionCount: 2,
      trendCompletionCount: 3,
    });
    renderApp('/');
    await screen.findByText('发现 today');
    const liveRegion = screen.getByLabelText('刷新结果');
    expect(liveRegion).toBeEmptyDOMElement();
    vi.useFakeTimers();

    const refresh = screen.getByRole('button', { name: '刷新发现' });
    fireEvent.click(refresh);

    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(refresh.querySelector('svg')).toHaveClass('spin');
    expect(screen.getByText('正在更新 2 个目标')).toBeVisible();

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(liveRegion).toHaveTextContent('刷新完成，新增 5 条内容');
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByLabelText('刷新结果')).toBe(liveRegion);
    expect(refresh).toHaveAttribute('aria-busy', 'false');
  });

  it('refreshes only the Topic selected as the current source', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent'), topic('topic-2', 'gpt-5.7')],
      feed: [feedItem('today', 'topic', 0, 'topic-2')],
    });
    renderApp('/');

    const source = await screen.findByRole('combobox', { name: '来源' });
    await within(source).findByRole('option', { name: 'gpt-5.7' });
    fireEvent.change(source, { target: { value: 'topic:topic-2' } });
    fireEvent.click(screen.getByRole('button', { name: '刷新发现' }));

    await waitFor(() => expect(requests.some(({ url, method }) => (
      url.endsWith('/topics/topic-2/refresh') && method === 'POST'
    ))).toBe(true));
    expect(requests.some(({ url, method }) => (
      url.endsWith('/topics/topic-1/refresh') && method === 'POST'
    ))).toBe(false);
    expect(requests.some(({ url, method }) => (
      url.endsWith('/trends/refresh') && method === 'POST'
    ))).toBe(false);
  });

  it('refreshes only trends when broad trends are the current source', async () => {
    installFetchMock({ topics: [topic('topic-1', 'AI Agent')], feed: [feedItem('today', 'trend')] });
    renderApp('/');

    const source = await screen.findByRole('combobox', { name: '来源' });
    fireEvent.change(source, { target: { value: 'trend' } });
    fireEvent.click(screen.getByRole('button', { name: '刷新发现' }));

    await waitFor(() => expect(requests.some(({ url, method }) => (
      url.endsWith('/trends/refresh') && method === 'POST'
    ))).toBe(true));
    expect(requests.some(({ url, method }) => (
      /\/topics\/[^/]+\/refresh$/.test(url) && method === 'POST'
    ))).toBe(false);
  });

  it('does not refresh an incomplete all-target scope while Topics are loading', async () => {
    let resolveTopics!: (topics: Topic[]) => void;
    const topicsResponse = new Promise<Topic[]>((resolve) => { resolveTopics = resolve; });
    installFetchMock({ topicsResponse, feed: [feedItem('today', 'topic')] });
    renderApp('/');

    const refresh = screen.getByRole('button', { name: '刷新发现' });
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    expect(requests.some(({ url, method }) => url.endsWith('/trends/refresh') && method === 'POST')).toBe(false);

    resolveTopics([]);
    await waitFor(() => expect(refresh).toBeEnabled());
  });

  it('does not offer Topic source options when there are no Topics', async () => {
    installFetchMock({ topics: [], feed: [] });
    renderApp('/');

    await screen.findByText('暂无发现内容');
    const source = screen.getByRole('combobox', { name: '来源' });
    expect(within(source).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '全部来源', '全网趋势',
    ]);
  });

  it('clears a selected Topic when a refreshed Topic snapshot removes it', async () => {
    const activeTopic = topic('topic-1', 'AI Agent');
    const mock = installFetchMock({
      topics: [activeTopic],
      feed: [feedItem('today', 'topic')],
    });
    const { client } = renderApp('/');

    const source = await screen.findByRole('combobox', { name: '来源' });
    await within(source).findByRole('option', { name: 'AI Agent' });
    fireEvent.change(source, { target: { value: 'topic:topic-1' } });
    await waitFor(() => expect(requests.some(({ url }) => url.includes('topicId=topic-1'))).toBe(true));

    mock.setTopics([]);
    await act(async () => { await client.invalidateQueries({ queryKey: ['topics'] }); });

    await waitFor(() => expect(source).toHaveValue('all'));
    await waitFor(() => {
      const latestFeedRequest = requests.filter(({ url }) => url.includes('/feed?')).at(-1)?.url;
      expect(latestFeedRequest).not.toContain('topicId=topic-1');
    });
  });

  it('explains a blocked trend-capable refresh and lets the user retry status loading', async () => {
    installFetchMock({ trendStatusFailures: 1, feed: [feedItem('today', 'trend')] });
    renderApp('/');

    expect(await screen.findByText('趋势状态无法加载')).toBeVisible();
    const refresh = screen.getByRole('button', { name: '刷新发现' });
    expect(refresh).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '重试趋势状态' }));
    await waitFor(() => expect(refresh).toBeEnabled());
  });

  it('keeps the Feed visible and offers synchronization retry after cache refresh fails', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent')],
      feed: [feedItem('existing', 'topic')],
      topicCompletionCount: 2,
      feedRefetchFailures: 1,
    });
    renderApp('/');
    expect(await screen.findByText('发现 existing')).toBeVisible();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: '刷新发现' }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(screen.getByText('发现 existing')).toBeVisible();
    expect(screen.getByLabelText('刷新结果')).toHaveTextContent('刷新结果已生成，但发现内容尚未同步');
    const retry = screen.getByRole('button', { name: '重试同步' });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByLabelText('刷新结果')).toHaveTextContent('刷新完成，新增 2 条内容');
  });

  it('shares one Topic poll and retains both concurrent keyed results', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent'), topic('topic-2', 'TypeScript')],
      topicCompletionCount: 2,
    });
    renderApp('/topics');
    await screen.findByText('AI Agent');
    await screen.findByText('TypeScript');
    const topicGetsBeforeRefresh = requests.filter(({ url, method }) => url.endsWith('/topics') && method === 'GET').length;
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: '刷新 AI Agent' }));
    fireEvent.click(screen.getByRole('button', { name: '刷新 TypeScript' }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });

    const topicGetsAfterRefresh = requests.filter(({ url, method }) => url.endsWith('/topics') && method === 'GET').length;
    expect(topicGetsAfterRefresh - topicGetsBeforeRefresh).toBe(1);
    const liveRegion = screen.getByLabelText('刷新结果');
    expect(liveRegion).toHaveTextContent('AI Agent：刷新完成，新增 2 条内容');
    expect(liveRegion).toHaveTextContent('TypeScript：刷新完成，新增 2 条内容');
    expect(screen.getByRole('button', { name: '刷新 AI Agent' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '刷新 TypeScript' })).toBeEnabled();
  });

  it('uses only the manager Topic poll across multiple nonterminal intervals', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent')],
      topicCompletionAfterPolls: 4,
    });
    renderApp('/topics');
    await screen.findByText('AI Agent');
    const topicGetsBeforeRefresh = requests.filter(({ url, method }) => url.endsWith('/topics') && method === 'GET').length;
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: '刷新 AI Agent' }));
    await act(async () => Promise.resolve());
    for (let interval = 1; interval <= 3; interval += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(1_500));
      const topicGets = requests.filter(({ url, method }) => url.endsWith('/topics') && method === 'GET').length;
      expect(topicGets - topicGetsBeforeRefresh).toBe(interval);
      expect(screen.getByRole('button', { name: '刷新 AI Agent' })).toBeDisabled();
    }
  });

  it('preserves background Topic polling when there is no manual refresh session', async () => {
    vi.useFakeTimers();
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent', runSummary('scheduled-running', 'running'))],
    });
    renderApp('/topics');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('AI Agent')).toBeVisible();
    const topicGetsBeforeInterval = requests.filter(({ url, method }) => url.endsWith('/topics') && method === 'GET').length;

    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    const topicGetsAfterInterval = requests.filter(({ url, method }) => url.endsWith('/topics') && method === 'GET').length;
    expect(topicGetsAfterInterval - topicGetsBeforeInterval).toBe(1);
  });

  it('restores a Topic row refresh indicator from queued server state', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent', runSummary('queued-manual', 'queued'))],
    });
    renderApp('/topics');

    const refresh = await screen.findByRole('button', { name: /AI Agent$/ });
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(refresh.querySelector('svg')).toHaveClass('spin');
  });

  it('restores Feed refresh progress from running Topic server state', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent', runSummary('running-manual', 'running'))],
      feed: [feedItem('existing', 'topic')],
    });
    renderApp('/');

    await screen.findByRole('heading', { name: /existing/ });
    const refresh = document.querySelector<HTMLButtonElement>('.page-header .refresh-button')!;
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(refresh.querySelector('svg')).toHaveClass('spin');
  });

  it('polls queued trend status until it becomes terminal', async () => {
    vi.useFakeTimers();
    installFetchMock({
      trendStatus: {
        ...initialTrendStatus,
        runStatus: 'queued',
        lastRun: runSummary('queued-trend', 'queued'),
      },
    });
    renderApp('/');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const initialRequests = requests.filter(({ url }) => url.endsWith('/trends/status')).length;

    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(requests.filter(({ url }) => url.endsWith('/trends/status')).length)
      .toBe(initialRequests + 1);
  });

  it('does not show refresh progress for a newly provisioned trend monitor without a run', async () => {
    installFetchMock({
      trendStatus: {
        ...initialTrendStatus,
        runStatus: 'queued',
        lastRun: null,
      },
    });
    renderApp('/');

    const refresh = await screen.findByRole('button', { name: '刷新发现' });
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(refresh).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText('正在更新 1 个目标')).not.toBeInTheDocument();
  });

  it('keeps a Topic row locked on stale synchronization and retries it explicitly', async () => {
    installFetchMock({ topics: [topic('topic-1', 'AI Agent')], topicCompletionCount: 2 });
    const { client } = renderApp('/topics');
    await screen.findByText('AI Agent');
    const invalidate = vi.spyOn(client, 'invalidateQueries')
      .mockRejectedValueOnce(new Error('cache offline'))
      .mockResolvedValueOnce(undefined);
    vi.useFakeTimers();

    const refresh = screen.getByRole('button', { name: '刷新 AI Agent' });
    fireEvent.click(refresh);
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(refresh).toBeDisabled();
    expect(screen.getByLabelText('刷新结果')).toHaveTextContent('AI Agent：刷新结果已生成，但发现内容尚未同步');
    const retry = screen.getByRole('button', { name: '重试同步 AI Agent' });
    fireEvent.click(retry);
    await act(async () => Promise.resolve());

    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(refresh).toBeEnabled();
    expect(screen.getByLabelText('刷新结果')).toHaveTextContent('AI Agent：刷新完成，新增 2 条内容');
  });

  it('disables and spins only the clicked Topic row while preserving other actions', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent'), topic('topic-2', 'TypeScript')],
      topicCompletionCount: 2,
    });
    renderApp('/topics');
    await screen.findByText('AI Agent');
    vi.useFakeTimers();

    const first = screen.getByRole('button', { name: '刷新 AI Agent' });
    const second = screen.getByRole('button', { name: '刷新 TypeScript' });
    fireEvent.click(first);

    expect(first).toBeDisabled();
    expect(first.querySelector('svg')).toHaveClass('spin');
    expect(second).toBeEnabled();
    expect(second.querySelector('svg')).not.toHaveClass('spin');

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.getByLabelText('刷新结果')).toHaveTextContent('刷新完成，新增 2 条内容');
  });

  it('retains and announces keyed completion messages across sequential Topic rows', async () => {
    installFetchMock({
      topics: [topic('topic-1', 'AI Agent'), topic('topic-2', 'TypeScript')],
      topicCompletionCount: 2,
    });
    renderApp('/topics');
    await screen.findByText('AI Agent');
    const liveRegion = screen.getByLabelText('刷新结果');
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: '刷新 AI Agent' }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(liveRegion).toHaveTextContent('AI Agent：刷新完成，新增 2 条内容');

    fireEvent.click(screen.getByRole('button', { name: '刷新 TypeScript' }));
    expect(liveRegion).toHaveTextContent('AI Agent：刷新完成，新增 2 条内容');
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(screen.getByLabelText('刷新结果')).toBe(liveRegion);
    expect(liveRegion).toHaveTextContent('AI Agent：刷新完成，新增 2 条内容');
    expect(liveRegion).toHaveTextContent('TypeScript：刷新完成，新增 2 条内容');
    expect(requests.filter(({ url, method }) => url.includes('/topics/') && method === 'POST')).toHaveLength(2);
  });

  it('submits one keyword and keeps schedule, expanded terms, errors, and source status', async () => {
    const created = topic('topic-created', 'AI Agent', runSummary('initial', 'queued'));
    const existing = {
      ...topic('topic-1', 'TypeScript'),
      lastError: { code: 'AI_NOT_CONFIGURED', message: '尚未配置 OpenRouter Key' },
    };
    installFetchMock({
      topics: [existing],
      created,
      sources: [
        { id: 'hacker-news', label: 'Hacker News', category: 'community', status: 'enabled' },
        { id: 'twitterapi-io', label: 'X', category: 'social', status: 'not_configured' },
      ],
    });
    renderApp('/topics');

    fireEvent.change(screen.getByLabelText('主题关键词'), { target: { value: 'AI Agent' } });
    fireEvent.click(screen.getByRole('button', { name: '创建主题' }));
    await waitFor(() => expect(requests.find(({ url, method }) => (
      url.endsWith('/topics') && method === 'POST'
    ))?.body).toEqual({ keyword: 'AI Agent' }));
    expect((await screen.findAllByText(/每 12 小时/)).length).toBeGreaterThan(0);
    expect(screen.getByText('TypeScript news')).toBeVisible();
    expect(screen.getByText('尚未配置 OpenRouter Key')).toBeVisible();
    expect(await screen.findByText('Hacker News')).toBeVisible();
    expect(screen.getByText('已启用')).toBeVisible();
    expect(screen.getByText('待配置')).toBeVisible();
  });

  it('edits the main keyword and expanded terms inline', async () => {
    const existing = {
      ...topic('topic-1', 'AI Agent'),
      expandedTerms: ['AI agent', '智能体'],
    };
    installFetchMock({ topics: [existing] });
    renderApp('/topics');

    expect(await screen.findByText('AI agent')).toBeVisible();
    expect(screen.queryAllByRole('button', { name: /删除扩展词/ })).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: '编辑 AI Agent 关键词' }));
    const keyword = screen.getByRole('textbox', { name: '主关键词' });
    expect(keyword).toHaveValue('AI Agent');
    fireEvent.change(keyword, { target: { value: 'Agent Workspace' } });
    const firstTerm = screen.getByRole('textbox', { name: '扩展词 1' });
    fireEvent.change(firstTerm, { target: { value: 'agent framework' } });
    fireEvent.click(screen.getByRole('button', { name: '删除扩展词 智能体' }));
    fireEvent.click(screen.getByRole('button', { name: '添加扩展词' }));

    const addedTerm = screen.getByRole('textbox', { name: '扩展词 2' });
    expect(addedTerm).toHaveFocus();
    fireEvent.change(addedTerm, { target: { value: 'agent tools' } });
    expect(screen.queryByRole('button', { name: '刷新 AI Agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除 AI Agent 关键词' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存修改 AI Agent' }));

    await waitFor(() => expect(requests.find(({ method }) => method === 'PATCH')?.body).toEqual({
      keyword: 'Agent Workspace',
      expandedTerms: ['agent framework', 'agent tools'],
    }));
  });

  it('saves an existing topic with all AI-generated expanded terms', async () => {
    const expandedTerms = Array.from({ length: 28 }, (_, index) => `AI agent term ${index + 1}`);
    const existing = {
      ...topic('topic-1', 'AI Agent'),
      expandedTerms,
    };
    installFetchMock({ topics: [existing] });
    renderApp('/topics');

    fireEvent.click(await screen.findByRole('button', { name: '编辑 AI Agent 关键词' }));
    fireEvent.change(screen.getByRole('textbox', { name: '主关键词' }), {
      target: { value: 'Agent Workspace' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改 AI Agent' }));

    await waitFor(() => expect(requests.find(({ method }) => method === 'PATCH')?.body).toEqual({
      keyword: 'Agent Workspace',
      expandedTerms,
    }));
  });

  it('discards expanded term chip drafts', async () => {
    const existing = {
      ...topic('topic-1', 'AI Agent'),
      expandedTerms: ['AI agent', '智能体'],
    };
    installFetchMock({ topics: [existing] });
    renderApp('/topics');

    fireEvent.click(await screen.findByRole('button', { name: '编辑 AI Agent 关键词' }));
    fireEvent.change(screen.getByRole('textbox', { name: '扩展词 1' }), {
      target: { value: 'changed draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: '删除扩展词 智能体' }));
    fireEvent.click(screen.getByRole('button', { name: '取消修改 AI Agent' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑 AI Agent 关键词' }));

    expect(screen.getByRole('textbox', { name: '扩展词 1' })).toHaveValue('AI agent');
    expect(screen.getByRole('textbox', { name: '扩展词 2' })).toHaveValue('智能体');
    expect(requests.some(({ method }) => method === 'PATCH')).toBe(false);
  });

  it('shows immediate Topic creation progress before the API responds', async () => {
    let resolveCreated!: (value: Topic) => void;
    const createdResponse = new Promise<Topic>((resolve) => { resolveCreated = resolve; });
    installFetchMock({ createdResponse });
    renderApp('/topics');
    await screen.findByText('尚未创建主题');

    fireEvent.change(screen.getByLabelText('主题关键词'), { target: { value: 'Rust' } });
    fireEvent.click(screen.getByRole('button', { name: '创建主题' }));

    const pending = screen.getByRole('status', { name: /Rust/ });
    expect(pending).toBeVisible();
    expect(pending.querySelector('svg')).toHaveClass('spin');
    resolveCreated(topic('topic-created', 'Rust', runSummary('initial', 'queued')));
    await waitFor(() => expect(screen.queryByRole('status', { name: /Rust/ })).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Rust' })).toBeVisible();
  });

  it('removes failed creation progress and restores the submitted keyword', async () => {
    installFetchMock({ createFailure: true });
    renderApp('/topics');
    await screen.findByText('尚未创建主题');

    const input = screen.getByLabelText('主题关键词');
    fireEvent.change(input, { target: { value: 'Rust' } });
    fireEvent.click(screen.getByRole('button', { name: '创建主题' }));

    await waitFor(() => expect(screen.queryByRole('status', { name: /Rust/ })).not.toBeInTheDocument());
    expect(input).toHaveValue('Rust');
    expect(screen.getByText('Create failed')).toBeVisible();
  });

  it('defines stable refresh dimensions and a static reduced-motion state', () => {
    const css = readFileSync('apps/web/src/styles.css', 'utf8');
    expect(css).toMatch(/\.refresh-button\s*\{[^}]*width:\s*38px;[^}]*height:\s*38px;/s);
    expect(css).toMatch(/\.pull-indicator\s*\{[^}]*height:\s*32px;/s);
    expect(css).toMatch(/\.origin-label\s*\{[^}]*max-width:\s*220px;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(css).not.toContain('.segmented--origin');
    expect(css).not.toContain('.origin-label--trend');
    expect(css).toContain('@keyframes refresh-spin');
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.spin\s*\{[^}]*animation:\s*none/s);
  });
});
