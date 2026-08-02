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
};

const trendStatus: TrendStatus = {
  runStatus: 'queued',
  nextRunAt: null,
  intervalHours: 4,
  lastError: null,
  lastRun: null,
};

describe('web API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('validates and sends all Feed filters with a 30d default, then parses FeedItem', async () => {
    const fetchMock = vi.fn(async () => Response.json([feedItem]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.feed({ origin: 'topic', kind: 'hot', topicId: 'topic/a' }))
      .resolves.toEqual([feedItem]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/feed?topicId=topic%2Fa&kind=hot&range=30d&origin=topic',
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
    const fetchMock = vi.fn(async () => Response.json([feedItem]));
    vi.stubGlobal('fetch', fetchMock);

    await api.feed({
      q: '  智能体工程  ',
      origin: 'topic',
      topicId: 'topic/a',
      kind: 'quality',
      range: 'all',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/feed?topicId=topic%2Fa&kind=quality&range=all&origin=topic&q=%E6%99%BA%E8%83%BD%E4%BD%93%E5%B7%A5%E7%A8%8B',
      expect.any(Object),
    );
  });

  it('rejects legacy item shapes without an origin', async () => {
    const { origin: _origin, ...legacyItem } = feedItem;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([legacyItem])));

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
});
