import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { YouTubeConnector } from './youtube.js';

const plan: SourceQueryPlan = {
  matchPolicy: buildKeywordPolicy('agent runtime'),
  keyword: 'agent runtime', expandedTerms: [], queries: ['agent runtime'], sourceTypes: ['video'],
  windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z', maxCandidates: 5,
};

describe('YouTubeConnector', () => {
  it('combines search and video metadata into source candidates', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: { videoId: 'video-1' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{
        id: 'video-1', snippet: { title: 'Agent runtime demo', description: 'Detailed chapters and migration notes.',
          channelTitle: 'Project Channel', channelId: 'channel-1', publishedAt: '2026-07-25T12:00:00Z' },
        statistics: { viewCount: '100', likeCount: '12', commentCount: '3' },
      }] }), { status: 200 }));
    const connector = new YouTubeConnector({ apiKey: 'youtube-key' }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    const search = new URL(String(fetcher.mock.calls[0]![0]));
    expect(search.pathname).toBe('/youtube/v3/search');
    expect(search.searchParams.get('q')).toBe('agent runtime');
    expect(search.searchParams.get('publishedAfter')).toBe(plan.windowStart);
    const metadata = new URL(String(fetcher.mock.calls[1]![0]));
    expect(metadata.pathname).toBe('/youtube/v3/videos');
    expect(metadata.searchParams.get('id')).toBe('video-1');
    expect(result).toMatchObject({ requestCount: 2, candidates: [expect.objectContaining({
      connectorId: 'youtube', sourceType: 'video', platform: 'YouTube', externalId: 'video-1',
      url: 'https://www.youtube.com/watch?v=video-1', content: 'Detailed chapters and migration notes.',
      authorName: 'Project Channel', authorHandle: 'channel-1',
      engagement: { views: 100, likes: 12, comments: 3 },
      proof: { kind: 'api_record', connectorId: 'youtube', externalId: 'video-1' },
    })] });
  });

  it('is disabled without a key and redacts provider errors', async () => {
    expect(new YouTubeConnector({ apiKey: undefined }).isEnabled()).toBe(false);
    const connector = new YouTubeConnector({ apiKey: 'youtube-key' }, vi.fn().mockResolvedValue(
      new Response('{"error":"youtube-key"}', { status: 403 }),
    ) as unknown as typeof fetch);
    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_AUTH_FAILED', retryable: false,
    });
    await expect(connector.search(plan, new AbortController().signal)).rejects.not.toThrow(/youtube-key/);
  });
});
