import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { YouTubeCreatorConnector } from './youtube-creator.js';

const channelId = 'UC1234567890123456789012';
const plan: SourceQueryPlan = {
  keyword: 'Example Channel',
  matchPolicy: buildKeywordPolicy('Example Channel'),
  expandedTerms: [],
  queries: ['Example Channel'],
  sourceTypes: ['video'],
  windowStart: '2026-08-01T00:00:00.000Z',
  windowEnd: '2026-08-08T00:00:00.000Z',
  maxCandidates: 30,
};

describe('YouTubeCreatorConnector', () => {
  it('reads a stable channel uploads playlist and returns source-proven videos', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{
        id: channelId,
        snippet: { title: 'Renamed Channel', customUrl: '@example' },
        contentDetails: { relatedPlaylists: { uploads: 'UU1234567890123456789012' } },
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          contentDetails: { videoId: 'video-1' },
          snippet: { publishedAt: '2026-08-07T08:00:00Z', videoOwnerChannelId: channelId },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{
        id: 'video-1',
        snippet: {
          title: 'A complete agent runtime walkthrough',
          description: 'Detailed chapters, configuration, migration steps, and rollback guidance.',
          channelTitle: 'Renamed Channel',
          channelId,
          publishedAt: '2026-08-07T08:00:00Z',
          defaultAudioLanguage: 'en',
          thumbnails: {},
        },
        statistics: { viewCount: '1200', likeCount: '95', commentCount: '12' },
      }] }), { status: 200 }));
    const connector = new YouTubeCreatorConnector(
      { apiKey: 'youtube-key', channelId, pageBudget: 1 },
      fetcher as typeof fetch,
    );

    const result = await connector.search(plan, new AbortController().signal);

    expect(result.requestCount).toBe(3);
    expect(result.identity).toEqual({
      displayName: 'Renamed Channel',
      profileUrl: `https://www.youtube.com/channel/${channelId}`,
      handle: '@example',
    });
    expect(result.candidates).toEqual([expect.objectContaining({
      connectorId: 'youtube-creator',
      sourceType: 'video',
      platform: 'YouTube',
      externalId: 'video-1',
      url: 'https://www.youtube.com/watch?v=video-1',
      authorName: 'Renamed Channel',
      authorHandle: channelId,
      engagement: { views: 1200, likes: 95, comments: 12 },
      proof: { kind: 'api_record', connectorId: 'youtube-creator', externalId: 'video-1' },
      creatorContext: expect.objectContaining({ contentType: 'original' }),
    })]);
    const channelUrl = new URL(String(fetcher.mock.calls[0]![0]));
    expect(channelUrl.pathname).toBe('/youtube/v3/channels');
    expect(channelUrl.searchParams.get('id')).toBe(channelId);
    const playlistUrl = new URL(String(fetcher.mock.calls[1]![0]));
    expect(playlistUrl.pathname).toBe('/youtube/v3/playlistItems');
    expect(playlistUrl.searchParams.get('playlistId')).toBe('UU1234567890123456789012');
  });

  it('fails safely when the API key is absent or rejected', async () => {
    await expect(new YouTubeCreatorConnector({ apiKey: undefined, channelId }).search(
      plan,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'CONNECTOR_NOT_CONFIGURED' });
    const connector = new YouTubeCreatorConnector(
      { apiKey: 'youtube-key', channelId },
      vi.fn().mockResolvedValue(new Response('{"error":"youtube-key"}', { status: 403 })) as typeof fetch,
    );
    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_AUTH_FAILED', retryable: false,
    });
    await expect(connector.search(plan, new AbortController().signal)).rejects.not.toThrow(/youtube-key/);
  });
});
