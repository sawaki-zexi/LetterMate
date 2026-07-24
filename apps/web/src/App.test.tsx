// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryItem, Topic } from '@lettermate/contracts';
import App from './App.js';
import './test-setup.js';

const discoveryItem: DiscoveryItem = {
  id: 'item-1', topicId: 'topic-1', kind: 'quality', title: 'Agent guide',
  summary: '中文摘要', reason: '内容深入', sourceUrls: ['https://example.com/guide'],
  publishedAt: null, discoveredAt: '2026-07-24T08:00:00.000Z',
};
const requests: Array<{ url: string; body?: unknown }> = [];

function installFetchMock(topics: Topic[], feed: DiscoveryItem[], created?: Topic) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    if (url.endsWith('/topics') && init?.method === 'POST') return Response.json(created!, { status: 201 });
    if (url.endsWith('/topics')) return Response.json(topics);
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
    requests.length = 0;
    vi.unstubAllGlobals();
  });

  it('submits only one keyword and polls queued topics', async () => {
    const created: Topic = {
      id: 'topic-1', userId: 'user-a', keyword: 'AI Agent', expandedTerms: [],
      createdAt: '2026-07-24T08:00:00.000Z', lastRunAt: null, runStatus: 'queued', lastError: null,
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
      runStatus: 'failed', lastError: { code: 'AI_NOT_CONFIGURED', message: '尚未配置 OpenRouter Key' },
    }], [discoveryItem]);
    renderApp('/');
    expect(await screen.findByText('尚未配置 OpenRouter Key')).toBeVisible();
    expect(screen.getByText(discoveryItem.title)).toBeVisible();
  });
});
