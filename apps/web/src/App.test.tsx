// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Creator,
  CreatorItem,
  CreatorIdentityCandidate,
  CreatorPlatformStatus,
  AuthSession,
  DiscoverySourceStatus,
  DigestPreference,
  DigestPreview,
  DigestRecipient,
  DigestStatus,
  DigestTestEmail,
  FeedItem,
  InterestMemory,
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
    pausedAt: null,
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
  origin: Extract<FeedItem['origin'], 'topic' | 'trend'>,
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
    contentKey: `https://example.com/${id}`,
    feedback: null,
  };
  return origin === 'topic'
    ? {
        ...common, origin, topicId, topicKeyword: 'gpt-5.7', topicKeywordActive: true,
        origins: [{ origin: 'topic', topicId, topicKeyword: 'gpt-5.7', topicKeywordActive: true }],
      }
    : { ...common, origin, topicId: null, origins: [{ origin: 'trend' }] };
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
  creatorCandidates?: CreatorIdentityCandidate[];
  creatorItems?: CreatorItem[];
  creatorPlatforms?: CreatorPlatformStatus[];
  creators?: Creator[];
  topics?: Topic[];
  topicsResponse?: Promise<Topic[]>;
  feed?: FeedItem[];
  nextFeed?: FeedItem[];
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
  feedbackFailure?: boolean;
  topicCompletionAfterPolls?: number;
  trendStatus?: TrendStatus;
  interests?: InterestMemory;
  digestPreference?: DigestPreference;
  digestPreview?: DigestPreview;
  digestStatus?: DigestStatus;
  digestRecipient?: DigestRecipient;
  digestTestEmail?: DigestTestEmail;
  authSession?: AuthSession;
}

function installFetchMock({
  creatorCandidates = [],
  creatorItems = [],
  creatorPlatforms = [{ id: 'rss', label: 'RSS/Atom', status: 'enabled' }],
  creators: initialCreators = [],
  topics: initialTopics = [],
  topicsResponse,
  feed = [],
  nextFeed,
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
  feedbackFailure = false,
  topicCompletionAfterPolls = 1,
  trendStatus: configuredTrendStatus = initialTrendStatus,
  interests: initialInterests = {
    personalizationEnabled: true, resetAt: null, recent: [], longTerm: [], reduced: [],
  },
  digestPreference: initialDigestPreference = {
    enabled: false, localTime: '08:00', timezone: 'Asia/Shanghai',
  },
  digestPreview = { generatedAt: now.toISOString(), items: [] },
  digestStatus = {
    deliveryCapability: 'not_configured', nextLocalSend: null, recentRun: null,
  },
  digestRecipient: initialDigestRecipient = {
    email: 'user-a@example.local', status: 'unverified', verifiedAt: null,
  },
  digestTestEmail = {
    id: 'test-email-1', status: 'succeeded', createdAt: now.toISOString(),
    finishedAt: now.toISOString(), errorCode: null,
  },
  authSession: initialAuthSession = {
    authenticated: true,
    user: { id: 'user-a', email: 'user-a@example.local', timezone: 'Asia/Shanghai' },
    csrfToken: null,
  },
}: FetchMockOptions = {}) {
  const refreshedTopicIds = new Set<string>();
  let currentCreators = initialCreators;
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

    if (url.endsWith('/auth/session')) return Response.json(initialAuthSession);
    if ((url.endsWith('/auth/login') || url.endsWith('/auth/register')) && method === 'POST') {
      initialAuthSession = {
        authenticated: true,
        user: {
          id: 'authenticated-user',
          email: body.email,
          timezone: body.timezone ?? 'Asia/Shanghai',
        },
        csrfToken: 'csrf-token-with-sufficient-length',
      };
      return Response.json(initialAuthSession);
    }
    if (url.endsWith('/auth/logout') && method === 'POST') {
      initialAuthSession = { authenticated: false, user: null, csrfToken: null };
      return new Response(null, { status: 204 });
    }

    if (url.endsWith('/digest-preference') && method === 'PUT') {
      initialDigestPreference = body as DigestPreference;
      return Response.json(initialDigestPreference);
    }
    if (url.endsWith('/digest-preference')) return Response.json(initialDigestPreference);
    if (url.endsWith('/digest-preview')) return Response.json(digestPreview);
    if (url.endsWith('/digest-status')) return Response.json(digestStatus);
    if (url.endsWith('/digest-test-email') && method === 'POST') {
      return Response.json(digestTestEmail);
    }
    if (url.includes('/digest-test-email/')) return Response.json(digestTestEmail);
    if (url.endsWith('/digest-recipient/verification') && method === 'POST') {
      initialDigestRecipient = {
        email: String(body.email).trim().toLowerCase(),
        status: 'pending',
        verifiedAt: null,
      };
      return Response.json(initialDigestRecipient);
    }
    if (url.includes('/digest-recipient/confirm?')) {
      return Response.json({ status: 'verified' });
    }
    if (url.includes('/digest/unsubscribe?')) {
      return Response.json({ status: 'unsubscribed' });
    }
    if (url.endsWith('/digest-recipient')) return Response.json(initialDigestRecipient);

    if (url.endsWith('/interests/settings') && method === 'PUT') {
      initialInterests = { ...initialInterests, personalizationEnabled: body.personalizationEnabled };
      return Response.json(initialInterests);
    }
    const forgottenInterest = url.match(/\/interests\/([^/]+)$/);
    if (forgottenInterest && method === 'DELETE') {
      const id = decodeURIComponent(forgottenInterest[1] ?? '');
      initialInterests = {
        ...initialInterests,
        recent: initialInterests.recent.filter((theme) => theme.id !== id),
        longTerm: initialInterests.longTerm.filter((theme) => theme.id !== id),
        reduced: initialInterests.reduced.filter((theme) => theme.id !== id),
      };
      return Response.json(initialInterests);
    }
    if (url.endsWith('/interests') && method === 'DELETE') {
      initialInterests = { ...initialInterests, resetAt: now.toISOString(), recent: [], longTerm: [], reduced: [] };
      return Response.json(initialInterests);
    }
    if (url.endsWith('/interests')) return Response.json(initialInterests);

    if (url.endsWith('/creators/resolve') && method === 'POST') {
      return Response.json({ candidates: creatorCandidates });
    }
    if (url.endsWith('/creator-platforms')) return Response.json(creatorPlatforms);
    if (/\/creators\/[^/]+\/items$/.test(url)) return Response.json(creatorItems);
    if (url.endsWith('/creators') && method === 'POST') {
      const selected = creatorCandidates.filter((candidate) => (
        body.resolutionTokens?.includes(candidate.resolutionToken)
      ));
      const candidate = selected[0];
      const creator: Creator = {
        id: 'creator-1', userId: 'user-a', platform: 'rss', displayName: candidate?.displayName ?? 'example.com',
        profileUrl: candidate?.profileUrl ?? body.url,
        feedUrl: candidate?.feedUrl ?? body.url,
        createdAt: now.toISOString(), pausedAt: null,
        lastRunAt: null, nextRunAt: null, runStatus: 'queued', lastError: null, degradedSources: [], lastRun: null,
      };
      currentCreators = [creator, ...currentCreators];
      return Response.json(body.resolutionTokens ? [creator] : creator, { status: 202 });
    }
    const creatorMatch = url.match(/\/creators\/([^/]+)$/);
    if (creatorMatch && method === 'DELETE') {
      currentCreators = currentCreators.filter((creator) => creator.id !== decodeURIComponent(creatorMatch[1] ?? ''));
      return new Response(null, { status: 204 });
    }
    const creatorRefreshMatch = url.match(/\/creators\/([^/]+)\/refresh$/);
    if (creatorRefreshMatch && method === 'POST') {
      const id = decodeURIComponent(creatorRefreshMatch[1] ?? '');
      return Response.json(currentCreators.find((creator) => creator.id === id)!);
    }
    const creatorUpdateMatch = url.match(/\/creators\/([^/]+)$/);
    if (creatorUpdateMatch && method === 'PATCH') {
      const id = decodeURIComponent(creatorUpdateMatch[1] ?? '');
      const updated = { ...currentCreators.find((creator) => creator.id === id)!, pausedAt: body.paused ? now.toISOString() : null };
      currentCreators = currentCreators.map((creator) => creator.id === id ? updated : creator);
      return Response.json(updated);
    }
    if (url.endsWith('/creators')) return Response.json(currentCreators);

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
    const topicLifecycleMatch = url.match(/\/topics\/([^/]+)\/(pause|resume)$/);
    if (topicLifecycleMatch && method === 'POST') {
      const topicId = decodeURIComponent(topicLifecycleMatch[1] ?? '');
      const action = topicLifecycleMatch[2];
      const existing = currentTopics.find((candidate) => candidate.id === topicId)!;
      const updated = action === 'pause'
        ? { ...existing, pausedAt: now.toISOString(), nextRunAt: null }
        : {
            ...existing,
            pausedAt: null,
            runStatus: 'queued' as const,
            lastRun: runSummary(`resume-${topicId}`, 'queued'),
          };
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
    const feedbackMatch = url.match(/\/feedback\/(.+)$/);
    if (feedbackMatch && method === 'PUT') {
      if (feedbackFailure) {
        return Response.json({
          code: 'FEEDBACK_UNAVAILABLE', message: '反馈暂时无法保存', traceId: 'test',
        }, { status: 503 });
      }
      const contentKey = decodeURIComponent(feedbackMatch[1] ?? '');
      feed = feed.map((feedItem) => (
        feedItem.contentKey === contentKey ? { ...feedItem, feedback: body.value } : feedItem
      ));
      return Response.json({ contentKey, value: body.value });
    }
    const savedContentMatch = url.match(/\/saved-items\/(.+)$/);
    if (url.endsWith('/saved-items') && method === 'PUT') {
      const contentKeys = (body.contentKeys as string[]) ?? [];
      feed = feed.map((feedItem) => contentKeys.includes(feedItem.contentKey)
        ? { ...feedItem, readingState: body.state }
        : feedItem);
      return Response.json({
        items: contentKeys.map((contentKey) => ({ contentKey, state: body.state })),
      });
    }
    if (savedContentMatch && method === 'PUT') {
      const contentKey = decodeURIComponent(savedContentMatch[1] ?? '');
      feed = feed.map((feedItem) => (
        feedItem.contentKey === contentKey ? { ...feedItem, readingState: body.state } : feedItem
      ));
      return Response.json({ contentKey, state: body.state });
    }
    if (/\/items\/[^/?]+$/.test(url)) return Response.json(item!);
    if (url.includes('/feed')) {
      feedRequestCount += 1;
      const searchParams = new URL(url, 'http://test').searchParams;
      const query = searchParams.get('q');
      const cursor = searchParams.get('cursor');
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
      const reading = searchParams.get('reading');
      const responseItems = cursor && nextFeed ? nextFeed : query ? feedByQuery[query] ?? [] : feed;
      return Response.json({
        items: reading ? responseItems.filter((feedItem) => feedItem.readingState === reading) : responseItems,
        nextCursor: !cursor && nextFeed ? 'next-page' : null,
        truncated: false,
      });
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

  it('saves, archives, filters, and restores an item from the Feed', async () => {
    installFetchMock({ feed: [feedItem('reading-flow', 'trend')] });
    renderApp('/');
    await screen.findByRole('heading', { name: '发现 reading-flow' });

    fireEvent.click(screen.getByRole('button', { name: '保存到稍后读' }));
    expect(await screen.findByRole('button', { name: '归档' })).toBeVisible();
    expect(requests.some(({ url, body }) => (
      url.includes('/saved-items/') && (body as { state?: string } | undefined)?.state === 'saved'
    ))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(await screen.findByRole('button', { name: '恢复到稍后读' })).toBeVisible();
    const readingGroup = screen.getByRole('group', { name: '阅读状态' });
    fireEvent.click(within(readingGroup).getByRole('button', { name: '已归档' }));
    await waitFor(() => expect(requests.some(({ url }) => url.includes('reading=archived'))).toBe(true));
    expect(await screen.findByRole('heading', { name: '发现 reading-flow' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '恢复到稍后读' }));
    expect(await screen.findByText('暂无归档内容')).toBeVisible();
  });

  it('selects the current reading page and archives it in one request', async () => {
    installFetchMock({
      feed: [feedItem('bulk-one', 'trend'), feedItem('bulk-two', 'topic')],
    });
    renderApp('/');
    await screen.findByRole('heading', { name: '发现 bulk-one' });
    const readingGroup = screen.getByRole('group', { name: '阅读状态' });
    fireEvent.click(within(readingGroup).getByRole('button', { name: '稍后读' }));
    await screen.findByText('暂无稍后读内容');

    fireEvent.click(within(readingGroup).getByRole('button', { name: '全部' }));
    await screen.findByRole('heading', { name: '发现 bulk-one' });
    for (const item of ['bulk-one', 'bulk-two']) {
      const card = screen.getByRole('heading', { name: `发现 ${item}` }).closest('article');
      if (!card) throw new Error(`Missing card for ${item}`);
      fireEvent.click(within(card).getByRole('button', { name: '保存到稍后读' }));
      await waitFor(() => expect(within(card).getByRole('button', { name: '归档' })).toBeVisible());
    }
    fireEvent.click(within(readingGroup).getByRole('button', { name: '稍后读' }));
    await screen.findByRole('checkbox', { name: '选择当前页全部稍后读' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择当前页全部稍后读' }));
    expect(screen.getByRole('button', { name: /归档选中/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /归档选中/ }));
    await screen.findByText('暂无稍后读内容');
    expect(requests.some(({ url, method, body }) => (
      url.endsWith('/saved-items')
      && method === 'PUT'
      && (body as { contentKeys?: string[] } | undefined)?.contentKeys?.length === 2
    ))).toBe(true);
  });

  it('appends the next Feed page from the opaque cursor', async () => {
    installFetchMock({
      feed: [feedItem('page-one', 'topic')],
      nextFeed: [feedItem('page-two', 'trend')],
    });
    renderApp('/');

    expect(await screen.findByRole('heading', { name: '发现 page-one' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));

    expect(await screen.findByRole('heading', { name: '发现 page-two' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '发现 page-one' })).toBeVisible();
    expect(requests.some(({ url }) => url.includes('cursor=next-page'))).toBe(true);
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
      '全部来源', '全网趋势', '关注博主', 'AI Agent',
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
      '全部来源', '全网趋势', '关注博主',
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

  it('submits one keyword and keeps schedule, errors, and source status', async () => {
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

    fireEvent.change(screen.getByLabelText('监控关键词'), { target: { value: 'AI Agent' } });
    fireEvent.click(screen.getByRole('button', { name: '开始监控' }));
    await waitFor(() => expect(requests.find(({ url, method }) => (
      url.endsWith('/topics') && method === 'POST'
    ))?.body).toEqual({ keyword: 'AI Agent' }));
    expect((await screen.findAllByText(/每 12 小时/)).length).toBeGreaterThan(0);
    expect(screen.getByText('尚未配置 OpenRouter Key')).toBeVisible();
    expect(await screen.findByText('Hacker News')).toBeVisible();
    expect(screen.getByText('已启用')).toBeVisible();
    expect(screen.getByText('未配置')).toBeVisible();
    expect(screen.getByText('1 个已启用 · 1 个未配置')).toBeVisible();
  });

  it('sets, clears, and switches persisted feedback on a Feed card', async () => {
    installFetchMock({ feed: [feedItem('today', 'topic')] });
    renderApp('/');

    const interested = await screen.findByRole('button', { name: '感兴趣' });
    const less = screen.getByRole('button', { name: '减少推荐' });
    fireEvent.click(interested);
    await waitFor(() => expect(interested).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(interested);
    await waitFor(() => expect(interested).toHaveAttribute('aria-pressed', 'false'));
    fireEvent.click(less);
    await waitFor(() => expect(less).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(requests.filter(({ url }) => url.includes('/feed')).length)
      .toBeGreaterThan(1));

    expect(requests.filter(({ url }) => url.includes('/feedback/')).map(({ body }) => body))
      .toEqual([{ value: 'interested' }, { value: null }, { value: 'less' }]);
  });

  it('keeps prior feedback when persistence fails', async () => {
    installFetchMock({
      feed: [{ ...feedItem('today', 'topic'), feedback: 'interested' }],
      feedbackFailure: true,
    });
    renderApp('/');

    const interested = await screen.findByRole('button', { name: '感兴趣' });
    const less = screen.getByRole('button', { name: '减少推荐' });
    fireEvent.click(less);
    expect(await screen.findByRole('alert')).toHaveTextContent('反馈暂时无法保存');
    expect(interested).toHaveAttribute('aria-pressed', 'true');
    expect(less).toHaveAttribute('aria-pressed', 'false');
  });

  it('follows an RSS creator and shows lifecycle controls', async () => {
    installFetchMock({
      creatorCandidates: [{
        resolutionToken: 'r'.repeat(32),
        platform: 'rss',
        displayName: 'Example Engineering',
        handle: 'Example Team',
        avatarUrl: null,
        bio: 'Engineering updates',
        verified: null,
        profileUrl: 'https://example.com/',
        feedUrl: 'https://example.com/feed.xml',
      }],
    });
    renderApp('/creators');

    expect(await screen.findByText('还没有关注博主')).toBeVisible();
    expect(await screen.findByText('RSS/Atom')).toBeVisible();
    expect(screen.getByText('可用')).toBeVisible();
    fireEvent.change(screen.getByLabelText('博主或主页'), { target: { value: 'https://example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: '查找' }));
    expect(await screen.findByText('Example Engineering')).toBeVisible();
    expect(screen.getByLabelText('选择 Example Engineering RSS/Atom')).toBeChecked();
    expect(requests.find(({ url, method }) => url.endsWith('/creators/resolve') && method === 'POST')?.body)
      .toEqual({ input: 'https://example.com/' });
    fireEvent.click(screen.getByRole('button', { name: '关注 1' }));
    expect(await screen.findByRole('heading', { name: 'Example Engineering' })).toBeVisible();
    expect(requests.find(({ url, method }) => url.endsWith('/creators') && method === 'POST')?.body)
      .toEqual({ resolutionTokens: ['r'.repeat(32)] });
    expect(screen.getByLabelText('暂停关注 Example Engineering')).toBeEnabled();
    expect(screen.getByLabelText('查看 Example Engineering 的内容')).toHaveAttribute('href', '/creators/creator-1');
    fireEvent.click(screen.getByLabelText('暂停关注 Example Engineering'));
    await waitFor(() => expect(screen.getByLabelText('恢复关注 Example Engineering')).toBeEnabled());
  });

  it('shows every valid creator item and preserves repost and reply context', async () => {
    const creator: Creator = {
      id: 'creator-1', userId: 'user-a', platform: 'x', displayName: 'Example Engineering',
      profileUrl: 'https://x.com/example', feedUrl: null, createdAt: now.toISOString(),
      pausedAt: null, lastRunAt: now.toISOString(), nextRunAt: null, runStatus: 'succeeded',
      lastError: null, degradedSources: [], lastRun: null,
    };
    const common: Omit<CreatorItem, 'id' | 'title' | 'contentType' | 'feedEligible'> = {
      creatorId: creator.id,
      kind: 'quality',
      summary: '中文摘要',
      reason: '与关注方向相关',
      sourceUrls: ['https://x.com/example/status/1'],
      publishedAt: now.toISOString(),
      discoveredAt: now.toISOString(),
      sourceType: 'social',
      platform: 'X',
      authorName: 'Example Engineering',
      authorHandle: 'example',
      externalId: '1',
      provenanceKind: 'api_record',
      originalAuthorName: null,
      originalAuthorHandle: null,
      originalContentId: null,
      originalContentUrl: null,
      parentContentId: null,
      parentContentUrl: null,
      parentContentText: null,
    };
    installFetchMock({
      creators: [creator],
      creatorItems: [{
        ...common,
        id: 'creator-item-repost',
        title: '值得保留的转发',
        contentType: 'repost',
        feedEligible: false,
        originalAuthorName: 'Original Author',
        originalAuthorHandle: 'original',
        originalContentId: 'original-1',
        originalContentUrl: 'https://x.com/original/status/1',
      }, {
        ...common,
        id: 'creator-item-reply',
        title: '带上下文的回复',
        contentType: 'reply',
        feedEligible: true,
        parentContentId: 'parent-1',
        parentContentUrl: 'https://x.com/parent/status/1',
        parentContentText: '这是需要保留的原帖内容。',
      }],
    });

    renderApp('/creators/creator-1');

    expect(await screen.findByRole('heading', { name: 'Example Engineering' })).toBeVisible();
    expect(screen.getByText('值得保留的转发')).toBeVisible();
    expect(screen.getByText('带上下文的回复')).toBeVisible();
    expect(screen.getByText('仅博主档案')).toBeVisible();
    expect(screen.getByText('已进入发现')).toBeVisible();
    expect(screen.getByText('Original Author · @original')).toBeVisible();
    expect(screen.getByText('这是需要保留的原帖内容。')).toBeVisible();
    expect(screen.getAllByText('推荐理由')).toHaveLength(1);
    expect(screen.getAllByText('与关注方向相关')).toHaveLength(1);
    expect(requests).toContainEqual(expect.objectContaining({
      url: '/api/v1/creators/creator-1/items',
      method: 'GET',
    }));
  });

  it('accepts a creator name and keeps an empty resolution distinct from creation', async () => {
    installFetchMock();
    renderApp('/creators');

    fireEvent.change(await screen.findByLabelText('博主或主页'), {
      target: { value: 'Karpathy' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查找' }));

    expect(await screen.findByText('未找到匹配账号')).toBeVisible();
    expect(requests).toContainEqual(expect.objectContaining({
      url: '/api/v1/creators/resolve',
      method: 'POST',
      body: { input: 'Karpathy' },
    }));
    expect(requests.some(({ url, method }) => url.endsWith('/creators') && method === 'POST'))
      .toBe(false);
  });

  it('renders the proxied avatar returned for an X creator candidate', async () => {
    const avatarUrl = 'https://wsrv.nl/?url=https%3A%2F%2Fpbs.twimg.com%2Fprofile_images%2Fkarpathy.jpg&w=96&h=96&fit=cover&output=webp';
    installFetchMock({
      creatorCandidates: [{
        resolutionToken: 'x'.repeat(32),
        platform: 'x',
        displayName: 'Andrej Karpathy',
        handle: '@karpathy',
        avatarUrl,
        bio: 'Building AI systems',
        verified: true,
        profileUrl: 'https://x.com/karpathy',
        feedUrl: null,
      }],
    });
    renderApp('/creators');

    fireEvent.change(await screen.findByLabelText('博主或主页'), {
      target: { value: 'Karpathy' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查找' }));

    expect(await screen.findByText('Andrej Karpathy')).toBeVisible();
    expect(document.querySelector<HTMLImageElement>(`img[src="${avatarUrl}"]`)).toBeVisible();
  });

  it('labels Bilibili creator candidates and platform capability correctly', async () => {
    installFetchMock({
      creatorPlatforms: [
        { id: 'rss', label: 'RSS/Atom', status: 'enabled' },
        { id: 'x', label: 'X', status: 'enabled' },
        { id: 'bilibili', label: 'Bilibili', status: 'enabled' },
        { id: 'youtube', label: 'YouTube', status: 'not_configured' },
        { id: 'bluesky', label: 'Bluesky', status: 'enabled' },
      ],
      creatorCandidates: [{
        resolutionToken: 'b'.repeat(32),
        platform: 'bilibili',
        displayName: '影视飓风',
        handle: 'UID 946974',
        avatarUrl: 'https://i0.hdslb.com/avatar.jpg',
        bio: '无限进步',
        verified: true,
        profileUrl: 'https://space.bilibili.com/946974',
        feedUrl: null,
      }],
    });
    renderApp('/creators');

    fireEvent.change(await screen.findByLabelText('博主或主页'), {
      target: { value: 'https://space.bilibili.com/946974' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查找' }));

    expect(await screen.findByText('影视飓风')).toBeVisible();
    expect(screen.getByLabelText('选择 影视飓风 Bilibili')).toBeChecked();
    expect(screen.getByText('UID 946974')).toBeVisible();
    expect(screen.getAllByText('Bilibili').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('YouTube')).toBeVisible();
    expect(screen.getByText('未配置')).toBeVisible();
    expect(screen.getByText('Bluesky')).toBeVisible();
    const avatar = document.querySelector<HTMLImageElement>('img[src="https://i0.hdslb.com/avatar.jpg"]');
    expect(avatar).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(avatar!);
    expect(document.querySelector('img[src="https://i0.hdslb.com/avatar.jpg"]')).not.toBeInTheDocument();
    expect(document.querySelector('.creator-candidate__avatar')).toBeInTheDocument();
  });

  it('shows a degraded creator sync and keeps manual refresh available', async () => {
    const creator: Creator = {
      id: 'creator-degraded', userId: 'user-a', platform: 'bilibili', displayName: '影视飓风',
      profileUrl: 'https://space.bilibili.com/946974', feedUrl: null,
      createdAt: now.toISOString(), pausedAt: null, lastRunAt: now.toISOString(), nextRunAt: now.toISOString(),
      runStatus: 'degraded', lastError: { code: 'CREATOR_PARTIAL_SYNC', message: '部分来源暂时不可用，已保留可用内容' },
      degradedSources: [{ source: 'dynamic', code: 'CONNECTOR_ACCESS_RESTRICTED', retryable: true }], lastRun: null,
    };
    installFetchMock({ creators: [creator] });
    renderApp('/creators');

    expect(await screen.findByText('部分同步')).toBeVisible();
    expect(screen.getByText('动态流 暂不可用，已保留可用内容')).toBeVisible();
    expect(screen.getByLabelText('立即同步 影视飓风')).toBeEnabled();
  });

  it('edits only the main keyword and lets the worker regenerate variants', async () => {
    const existing = {
      ...topic('topic-1', 'AI Agent'),
      expandedTerms: ['AI agent', '智能体'],
    };
    installFetchMock({ topics: [existing] });
    renderApp('/topics');

    fireEvent.click(await screen.findByRole('button', { name: '编辑 AI Agent 关键词' }));
    const keyword = screen.getByRole('textbox', { name: '主关键词' });
    expect(keyword).toHaveValue('AI Agent');
    fireEvent.change(keyword, { target: { value: 'Agent Workspace' } });
    expect(screen.queryByRole('button', { name: '刷新 AI Agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除 AI Agent 关键词' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存修改 AI Agent' }));

    await waitFor(() => expect(requests.find(({ method }) => method === 'PATCH')?.body).toEqual({
      keyword: 'Agent Workspace',
      expandedTerms: [],
    }));
  });

  it('pauses and resumes a keyword monitor from its row', async () => {
    installFetchMock({ topics: [topic('topic-1', 'AI Agent')] });
    renderApp('/topics');

    fireEvent.click(await screen.findByRole('button', {
      name: '暂停 AI Agent 关键词监控',
    }));

    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({
      url: '/api/v1/topics/topic-1/pause',
      method: 'POST',
    })));
    expect(await screen.findByText('已暂停自动更新')).toBeVisible();
    expect(screen.getByRole('button', { name: '刷新 AI Agent' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '恢复 AI Agent 关键词监控' }));

    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({
      url: '/api/v1/topics/topic-1/resume',
      method: 'POST',
    })));
    expect(await screen.findByRole('button', { name: '暂停 AI Agent 关键词监控' })).toBeVisible();
  });

  it('shows immediate Topic creation progress before the API responds', async () => {
    let resolveCreated!: (value: Topic) => void;
    const createdResponse = new Promise<Topic>((resolve) => { resolveCreated = resolve; });
    installFetchMock({ createdResponse });
    renderApp('/topics');
    await screen.findByText('尚未创建关键词监控');

    fireEvent.change(screen.getByLabelText('监控关键词'), { target: { value: 'Rust' } });
    fireEvent.click(screen.getByRole('button', { name: '开始监控' }));

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
    await screen.findByText('尚未创建关键词监控');

    const input = screen.getByLabelText('监控关键词');
    fireEvent.change(input, { target: { value: 'Rust' } });
    fireEvent.click(screen.getByRole('button', { name: '开始监控' }));

    await waitFor(() => expect(screen.queryByRole('status', { name: /Rust/ })).not.toBeInTheDocument());
    expect(input).toHaveValue('Rust');
    expect(screen.getByText('Create failed')).toBeVisible();
  });

  it('shows and controls interest memory without exposing scores', async () => {
    installFetchMock({
      interests: {
        personalizationEnabled: true,
        resetAt: null,
        recent: [{
          id: 'tag-agents', name: 'AI Agents', kind: 'topic',
          sources: ['keyword', 'feedback'], updatedAt: now.toISOString(),
        }],
        longTerm: [],
        reduced: [],
      },
    });
    renderApp('/interests');

    expect(await screen.findByText('AI Agents')).toBeVisible();
    expect(screen.queryByText(/分数|权重|置信度/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '个性化排序' }));
    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({
      url: '/api/v1/interests/settings', method: 'PUT',
      body: { personalizationEnabled: false },
    })));

    fireEvent.click(screen.getByRole('button', { name: '忘记兴趣主题 AI Agents' }));
    await waitFor(() => expect(screen.queryByText('AI Agents')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '清空历史' }));
    expect(screen.getByRole('dialog', { name: '清空兴趣历史确认' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({
      url: '/api/v1/interests', method: 'DELETE',
    })));
  });

  it('updates daily email settings and renders a safe candidate preview', async () => {
    installFetchMock({
      digestRecipient: {
        email: 'user-a@example.local', status: 'verified', verifiedAt: now.toISOString(),
      },
      digestStatus: {
        deliveryCapability: 'configured',
        nextLocalSend: {
          localDate: '2026-08-09', localTime: '08:00', timezone: 'Asia/Shanghai',
        },
        recentRun: {
          status: 'succeeded', scheduledLocalDate: '2026-08-08',
          finishedAt: '2026-08-08T00:01:00.000Z', itemCount: 4,
        },
      },
      digestPreview: {
        generatedAt: now.toISOString(),
        items: [{
          contentKey: 'https://example.com/digest-item',
          title: '模型能力更新',
          summary: '已持久化的中文摘要。',
          reason: '包含重要版本变化。',
          sourceUrl: 'https://example.com/digest-item',
          publishedAt: now.toISOString(),
          platform: 'OpenAI',
          brief: {
            conclusion: '已持久化的中文摘要。',
            evidence: '包含重要版本变化。',
            uncertainty: '仍需核验完整原文。',
            followUp: '继续关注兼容性更新。',
          },
          citations: [{
            contentKey: 'https://example.com/digest-item',
            url: 'https://example.com/digest-item',
            platform: 'OpenAI',
            publishedAt: now.toISOString(),
          }],
        }],
      },
    });
    renderApp('/digest');

    expect(await screen.findByText('模型能力更新')).toBeVisible();
    expect(screen.getByText('已配置')).toBeVisible();
    expect(screen.getByText(/下次发送：2026-08-09 08:00/)).toBeVisible();
    expect(screen.getByText('已发送')).toBeVisible();
    expect(screen.getByText('4 条内容')).toBeVisible();
    expect(screen.getByRole('link', { name: /OpenAI/ })).toHaveAttribute(
      'href', 'https://example.com/digest-item',
    );
    expect(screen.getByText('仍需核验完整原文。')).toBeVisible();
    expect(screen.queryByText(/tag-|置信度|收件地址|内部排序/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '每日邮件' }));
    fireEvent.change(screen.getByLabelText('发送时间'), { target: { value: '09:30' } });
    fireEvent.change(screen.getByLabelText('时区'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(requests).toContainEqual({
      url: '/api/v1/digest-preference',
      method: 'PUT',
      body: { enabled: true, localTime: '09:30', timezone: 'Asia/Tokyo' },
    }));

    const previewRequests = requests.filter((entry) => entry.url === '/api/v1/digest-preview');
    fireEvent.click(screen.getByRole('button', { name: '刷新邮件预览' }));
    await waitFor(() => expect(
      requests.filter((entry) => entry.url === '/api/v1/digest-preview'),
    ).toHaveLength(previewRequests.length + 1));
  });

  it('requests verification for a user-entered digest recipient', async () => {
    installFetchMock({
      digestStatus: {
        deliveryCapability: 'configured', nextLocalSend: null, recentRun: null,
      },
    });
    renderApp('/digest');

    const recipientInput = await screen.findByRole('textbox', { name: '收件邮箱' });
    await waitFor(() => expect(recipientInput).toHaveValue('user-a@example.local'));
    expect(screen.getByText('未验证')).toBeVisible();
    fireEvent.change(recipientInput, { target: { value: 'Student@Example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '发送验证邮件' }));

    await waitFor(() => expect(requests).toContainEqual({
      url: '/api/v1/digest-recipient/verification',
      method: 'POST',
      body: { email: 'Student@Example.com' },
    }));
    expect(await screen.findByText('等待验证')).toBeVisible();
    expect(screen.getByText('验证邮件已发送，请检查收件箱')).toBeVisible();
    expect(screen.getByRole('button', { name: '重新发送验证邮件' })).toBeVisible();
  });

  it('keeps daily email disabled until the recipient is verified', async () => {
    installFetchMock({
      digestStatus: {
        deliveryCapability: 'configured', nextLocalSend: null, recentRun: null,
      },
    });
    renderApp('/digest');

    expect(await screen.findByText('验证收件邮箱后才能开启每日邮件')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '每日邮件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '发送测试邮件' })).toBeDisabled();
  });

  it('shows provider suppression and requires a different address before verification', async () => {
    installFetchMock({
      digestRecipient: {
        email: 'blocked@example.com', status: 'suppressed', verifiedAt: null,
      },
      digestStatus: {
        deliveryCapability: 'configured', nextLocalSend: null, recentRun: null,
      },
    });
    renderApp('/digest');

    const recipientInput = await screen.findByRole('textbox', { name: '收件邮箱' });
    await waitFor(() => expect(recipientInput).toHaveValue('blocked@example.com'));
    expect(await screen.findByText('已停用')).toBeVisible();
    expect(screen.getByText('该地址已被邮件服务停用，请更换地址后重新验证')).toBeVisible();
    expect(screen.getByRole('button', { name: '发送验证邮件' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '每日邮件' })).toBeDisabled();

    fireEvent.change(recipientInput, { target: { value: 'new@example.com' } });
    expect(screen.getByRole('button', { name: '发送验证邮件' })).toBeEnabled();
  });

  it('sends a test email to the verified recipient and shows delivery success', async () => {
    installFetchMock({
      digestRecipient: {
        email: 'verified@example.com', status: 'verified', verifiedAt: now.toISOString(),
      },
      digestStatus: {
        deliveryCapability: 'configured', nextLocalSend: null, recentRun: null,
      },
    });
    renderApp('/digest');

    const button = await screen.findByRole('button', { name: '发送测试邮件' });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => expect(requests).toContainEqual({
      url: '/api/v1/digest-test-email', method: 'POST', body: undefined,
    }));
    expect(await screen.findByText('测试邮件已发送')).toBeVisible();
  });

  it('confirms a digest recipient from the public email link', async () => {
    installFetchMock({
      authSession: { authenticated: false, user: null, csrfToken: null },
    });
    renderApp('/digest/verify?token=verification-token-value-that-is-long-enough');

    expect(await screen.findByRole('heading', { name: '邮箱已验证' })).toBeVisible();
    expect(requests).toContainEqual({
      url: '/api/v1/digest-recipient/confirm?token=verification-token-value-that-is-long-enough',
      method: 'GET',
      body: undefined,
    });
    expect(screen.getByRole('link', { name: '返回每日邮件' })).toHaveAttribute('href', '/digest');
  });

  it('unsubscribes daily email from the public email link without authentication', async () => {
    installFetchMock({
      authSession: { authenticated: false, user: null, csrfToken: null },
    });
    renderApp('/digest/unsubscribe?token=unsubscribe-token-value-that-is-long-enough');

    expect(await screen.findByRole('heading', { name: '已停止每日邮件' })).toBeVisible();
    expect(requests).toContainEqual({
      url: '/api/v1/digest/unsubscribe?token=unsubscribe-token-value-that-is-long-enough',
      method: 'GET',
      body: undefined,
    });
    expect(screen.getByText(/历史邮件和内容不会删除/)).toBeVisible();
  });

  it('shows account authentication before loading the private workspace', async () => {
    installFetchMock({
      authSession: { authenticated: false, user: null, csrfToken: null },
    });
    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'LetterMate' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '注册' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'student@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('button', { name: '创建账户' }));

    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({
      url: '/api/v1/auth/register',
      method: 'POST',
      body: expect.objectContaining({ email: 'student@example.com' }),
    })));
    expect(await screen.findByText('student@example.com')).toBeVisible();
  });

  it('defines stable refresh dimensions and a static reduced-motion state', () => {
    const css = readFileSync('apps/web/src/styles.css', 'utf8');
    expect(css).toMatch(/\.refresh-button\s*\{[^}]*width:\s*38px;[^}]*height:\s*38px;/s);
    expect(css).toMatch(/\.pull-indicator\s*\{[^}]*height:\s*32px;/s);
    expect(css).toMatch(/\.origin-label\s*\{[^}]*max-width:\s*360px;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(css).not.toContain('.segmented--origin');
    expect(css).not.toContain('.origin-label--trend');
    expect(css).toContain('@keyframes refresh-spin');
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.spin\s*\{[^}]*animation:\s*none/s);
  });
});
