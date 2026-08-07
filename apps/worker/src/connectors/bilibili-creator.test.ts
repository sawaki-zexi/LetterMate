import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { BilibiliCreatorConnector } from './bilibili-creator.js';

const plan: SourceQueryPlan = {
  keyword: '影视飓风',
  matchPolicy: buildKeywordPolicy('影视飓风'),
  expandedTerms: [],
  queries: ['影视飓风'],
  sourceTypes: ['video'],
  windowStart: '2026-08-01T00:00:00.000Z',
  windowEnd: '2026-08-08T00:00:00.000Z',
  maxCandidates: 30,
};

const nav = {
  code: -101,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

const video = (overrides: Record<string, unknown> = {}) => ({
  bvid: 'BV1example',
  title: '<em class="keyword">AI</em> 视频工作流更新',
  description: '包含完整的制作方法、技术取舍和复现步骤。',
  author: '影视飓风',
  mid: 946974,
  pubdate: 1786093200,
  play: 1000,
  video_review: 20,
  like: 100,
  ...overrides,
});

describe('BilibiliCreatorConnector', () => {
  it('refreshes account identity and paginates signed video search with stable mid filtering', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0, data: { card: { mid: '946974', name: '影视飓风' } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nav), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { result: [{ mid: 946974, uname: '影视飓风', res: [video()] }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { numPages: 2, result: [
          video(),
          video({ bvid: 'BV1other', mid: 123, author: '其他账号' }),
          video({ bvid: 'BV1second', title: '第二个公开视频', pubdate: 1786006800 }),
        ] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { numPages: 2, result: [video({
          bvid: 'BV1third', title: '第三个公开视频', pubdate: 1785920400,
        })] },
      }), { status: 200 }));
    const connector = new BilibiliCreatorConnector({
      mid: '946974',
      pageBudget: 2,
      now: () => new Date('2026-08-07T12:00:00.000Z'),
    }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    expect(result.requestCount).toBe(5);
    expect(result.identity).toEqual({
      displayName: '影视飓风',
      profileUrl: 'https://space.bilibili.com/946974',
      handle: 'UID 946974',
    });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]).toMatchObject({
      connectorId: 'bilibili-creator',
      sourceType: 'video',
      platform: 'Bilibili',
      externalId: 'BV1example',
      authorName: '影视飓风',
      authorHandle: 'UID 946974',
      creatorContext: { contentType: 'original' },
    });
    expect(result.candidates[0]!.title).toBe('AI 视频工作流更新');
    const signedUrls = fetcher.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname === '/x/web-interface/wbi/search/type');
    expect(signedUrls).toHaveLength(3);
    expect(signedUrls.every((url) => /^[a-f0-9]{32}$/.test(url.searchParams.get('w_rid') ?? ''))).toBe(true);
    expect(signedUrls[2]!.searchParams.get('page')).toBe('2');
  });

  it('maps Bilibili risk-control responses without leaking their body', async () => {
    const connector = new BilibiliCreatorConnector(
      { mid: '946974' },
      vi.fn().mockResolvedValue(new Response('risk challenge', { status: 412 })) as typeof fetch,
    );
    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_ACCESS_RESTRICTED',
      retryable: true,
      message: 'Bilibili public API is temporarily restricted',
    });
  });
});
