// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryItem, DiscoverySourceStatus, Topic } from '@lettermate/contracts';
import App from './App.js';
import './test-setup.js';

const discoveryItem: DiscoveryItem = {
  id: 'item-1', topicId: 'topic-1', kind: 'quality', title: 'Agent guide',
  summary: '中文摘要', reason: '内容深入', sourceUrls: ['https://x.com/project/status/100'],
  publishedAt: null, discoveredAt: '2026-07-24T08:00:00.000Z',
  sourceType: 'social', platform: 'X', authorName: 'Project Team',
  authorHandle: 'project', externalId: '100', provenanceKind: 'api_record',
};
const requests: Array<{ url: string; body?: unknown }> = [];

function installFetchMock(
  topics: Topic[],
  feed: DiscoveryItem[],
  created?: Topic,
  sources: DiscoverySourceStatus[] = [],
) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    if (url.endsWith('/topics') && init?.method === 'POST') return Response.json(created!, { status: 201 });
    if (url.endsWith('/topics')) return Response.json(topics);
    if (url.endsWith('/discovery-sources')) return Response.json(sources);
    if (url.includes('/feed')) return Response.json(feed);
    return Response.json({ code: 'NOT_FOUND', message: 'not found', traceId: 'test' }, { status: 404 });
  }));
}

function renderApp(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
}

describe('discovery workspace', () => {
  afterEach(() => {
    cleanup();
    requests.length = 0;
    vi.unstubAllGlobals();
  });

  it('submits only one keyword and polls queued topics', async () => {
    const created: Topic = {
      id: 'topic-1', userId: 'user-a', keyword: 'AI Agent', expandedTerms: [],
      createdAt: '2026-07-24T08:00:00.000Z', lastRunAt: null,
      nextRunAt: null, scheduleIntervalHours: 12, runStatus: 'queued', lastError: null,
    };
    installFetchMock([], [], created);
    renderApp('/topics');
    fireEvent.change(screen.getByLabelText('主题关键词'), { target: { value: 'AI Agent' } });
    fireEvent.click(screen.getByRole('button', { name: '创建主题' }));
    await waitFor(() => expect(requests.find((request) => request.url.endsWith('/topics') && request.body)?.body).toEqual({ keyword: 'AI Agent' }));
    expect(await screen.findByText('AI Agent')).toBeVisible();
  });

  it('shows AI_NOT_CONFIGURED without losing existing content', async () => {
    installFetchMock([{
      id: 'topic-1', userId: 'user-a', keyword: 'AI Agent', expandedTerms: [],
      createdAt: '2026-07-24T07:00:00.000Z', lastRunAt: '2026-07-24T08:00:00.000Z',
      nextRunAt: '2026-07-24T20:00:00.000Z', scheduleIntervalHours: 12,
      runStatus: 'failed', lastError: { code: 'AI_NOT_CONFIGURED', message: '尚未配置 OpenRouter Key' },
    }], [discoveryItem]);
    renderApp('/');
    expect(await screen.findByText('尚未配置 OpenRouter Key')).toBeVisible();
    expect(screen.getByText(discoveryItem.title)).toBeVisible();
  });

  it('switches between recent and all retained history', async () => {
    installFetchMock([], [discoveryItem]);
    renderApp('/');

    expect(await screen.findByText('X')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '全部历史' }));

    await waitFor(() => expect(requests.some((request) => (
      request.url.includes('/feed?') && request.url.includes('range=all')
    ))).toBe(true));
  });

  it('shows automatic schedule and safe connector states', async () => {
    installFetchMock([{
      id: 'topic-1', userId: 'user-a', keyword: 'AI Agent', expandedTerms: [],
      createdAt: '2026-07-24T07:00:00.000Z', lastRunAt: '2026-07-24T08:00:00.000Z',
      nextRunAt: '2026-07-28T08:00:00.000Z', scheduleIntervalHours: 12,
      runStatus: 'succeeded', lastError: null,
    }], [], undefined, [
      { id: 'hacker-news', label: 'Hacker News', category: 'community', status: 'enabled' },
      { id: 'twitterapi-io', label: 'X', category: 'social', status: 'not_configured' },
    ]);
    renderApp('/topics');

    expect(await screen.findByText(/每 12 小时/)).toBeVisible();
    expect(screen.getByText(/下次自动更新/)).toBeVisible();
    expect(await screen.findByText('Hacker News')).toBeVisible();
    expect(screen.getByText('已启用')).toBeVisible();
    expect(screen.getByText('待配置')).toBeVisible();
  });
});
