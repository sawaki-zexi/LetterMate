import type { FeedItem, FeedOrigin, FeedRange, TrendStatus } from '@lettermate/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';

const feedItem: FeedItem = {
  id: 'radar-1',
  origin: 'trend',
  topicId: null,
  kind: 'hot',
  title: 'Release',
  summary: '摘要',
  reason: '理由',
  sourceUrls: ['https://example.com/release'],
  publishedAt: null,
  discoveredAt: '2026-07-28T12:00:00.000Z',
  sourceType: 'web',
  platform: 'Example',
  authorName: null,
  authorHandle: null,
  externalId: null,
  provenanceKind: 'fetched_page',
  contentKey: 'https://example.com/release',
  feedback: null,
  origins: [{ origin: 'trend' }],
};

const trendStatus: TrendStatus = {
  runStatus: 'queued',
  nextRunAt: null,
  intervalHours: 4,
  lastError: null,
  lastRun: null,
};

const interestMemory = {
  personalizationEnabled: true,
  resetAt: null,
  recent: [{
    id: 'tag-agents', name: 'Agents', kind: 'topic' as const,
    sources: ['feedback' as const], updatedAt: '2026-08-08T08:00:00.000Z',
  }],
  longTerm: [],
  reduced: [],
};

describe('web API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses cookie credentials, persists CSRF from login, protects writes, and clears it on logout', async () => {
    const responses = [
      Response.json({
        authenticated: true,
        user: { id: 'user-1', email: 'student@example.com', timezone: 'Asia/Shanghai' },
        csrfToken: 'csrf-token-with-sufficient-length',
      }),
      Response.json({ contentKey: feedItem.contentKey, value: 'interested' }),
      new Response(null, { status: 204 }),
      Response.json({ contentKey: feedItem.contentKey, value: 'interested' }),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      responses.shift() ?? Response.json([])
    ));
    vi.stubGlobal('fetch', fetchMock);

    await api.login({ email: 'student@example.com', password: 'correct horse battery staple' });
    await api.setFeedback(feedItem.contentKey, { value: 'interested' });
    await api.logout();
    await api.setFeedback(feedItem.contentKey, { value: 'interested' });

    const loginInit = fetchMock.mock.calls[0]?.[1];
    const protectedInit = fetchMock.mock.calls[1]?.[1];
    const clearedInit = fetchMock.mock.calls[3]?.[1];
    expect(loginInit).toEqual(expect.objectContaining({ credentials: 'include' }));
    expect(protectedInit).toEqual(expect.objectContaining({ credentials: 'include' }));
    expect(new Headers(protectedInit?.headers).get('x-csrf-token'))
      .toBe('csrf-token-with-sufficient-length');
    expect(clearedInit).toEqual(expect.objectContaining({ credentials: 'include' }));
    expect(new Headers(clearedInit?.headers).get('x-csrf-token')).toBeNull();
  });

  it('validates and sends all Feed filters with defaults, then parses FeedPage', async () => {
    const page = { items: [feedItem], nextCursor: null, truncated: false };
    const fetchMock = vi.fn(async () => Response.json(page));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.feed({ origin: 'topic', kind: 'hot', topicId: 'topic/a' }))
      .resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/feed?topicId=topic%2Fa&kind=hot&range=30d&origin=topic&limit=30',
      expect.any(Object),
    );
    expect(() => api.feed({ range: 'recent' as FeedRange })).toThrow();
    expect(() => api.feed({ origin: 'keyword' as FeedOrigin })).toThrow();
  });

  it('rejects invalid Topic Feed filters before fetching', () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetchMock);

    expect(() => api.feed({ topicId: 'topic-1', origin: 'trend' })).toThrow();
    expect(() => api.feed({ topicId: '' })).toThrow();
    expect(() => api.feed({ topicId: '   ' })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trims and serializes a submitted persisted Feed search query', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      items: [feedItem], nextCursor: null, truncated: false,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.feed({
      q: '  智能体工程  ',
      origin: 'topic',
      topicId: 'topic/a',
      kind: 'quality',
      range: 'all',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/feed?topicId=topic%2Fa&kind=quality&range=all&origin=topic&q=%E6%99%BA%E8%83%BD%E4%BD%93%E5%B7%A5%E7%A8%8B&limit=30',
      expect.any(Object),
    );
  });

  it('rejects legacy item shapes without an origin', async () => {
    const { origin: _origin, ...legacyItem } = feedItem;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      items: [legacyItem], nextCursor: null, truncated: false,
    })));

    await expect(api.feed()).rejects.toThrow();
  });

  it('reads and refreshes trend status and parses Radar item detail', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/items/radar-1')) return Response.json(feedItem);
      return Response.json(trendStatus);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.trendStatus()).resolves.toEqual(trendStatus);
    await expect(api.refreshTrends()).resolves.toEqual(trendStatus);
    await expect(api.item('radar-1')).resolves.toEqual(feedItem);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/trends/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends the saved Feed filter and persists reading-list state', async () => {
    const responses = [
      Response.json({ items: [feedItem], nextCursor: null, truncated: false }),
      Response.json({ contentKey: feedItem.contentKey, state: 'saved' }),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.feed({ reading: 'saved' })).resolves.toEqual({
      items: [feedItem], nextCursor: null, truncated: false,
    });
    await expect(api.setSavedContent(feedItem.contentKey, { state: 'saved' })).resolves.toEqual({
      contentKey: feedItem.contentKey,
      state: 'saved',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/feed?range=30d&origin=all&reading=saved&limit=30');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/saved-items/${encodeURIComponent(feedItem.contentKey)}`);
  });

  it('writes validated feedback against the encoded stable content key', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      contentKey: feedItem.contentKey,
      value: 'interested',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.setFeedback(feedItem.contentKey, { value: 'interested' })).resolves.toEqual({
      contentKey: feedItem.contentKey,
      value: 'interested',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/feedback/${encodeURIComponent(feedItem.contentKey)}`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ value: 'interested' }) }),
    );
    expect(() => api.setFeedback(feedItem.contentKey, { value: 'like' as never })).toThrow();
  });

  it('archives a validated batch of reading-list items', async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [
      { contentKey: 'https://example.com/a', state: 'archived' },
      { contentKey: 'https://example.com/b', state: 'archived' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.archiveSavedContentBatch([
      'https://example.com/a', 'https://example.com/b',
    ])).resolves.toEqual({ items: [
      { contentKey: 'https://example.com/a', state: 'archived' },
      { contentKey: 'https://example.com/b', state: 'archived' },
    ] });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/saved-items',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          contentKeys: ['https://example.com/a', 'https://example.com/b'], state: 'archived',
        }),
      }),
    );
    expect(() => api.archiveSavedContentBatch([
      'https://example.com/a', 'https://example.com/a',
    ])).toThrow();
  });

  it('reads and controls interest memory with validated payloads', async () => {
    const fetchMock = vi.fn(async () => Response.json(interestMemory));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.interests()).resolves.toEqual(interestMemory);
    await api.setInterestSettings({ personalizationEnabled: false });
    await api.forgetInterest('tag/agents');
    await api.clearInterestHistory();

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/interests/settings', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ personalizationEnabled: false }),
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/interests/tag%2Fagents',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/interests',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(() => api.setInterestSettings({ personalizationEnabled: 'yes' as never })).toThrow();
  });
});
