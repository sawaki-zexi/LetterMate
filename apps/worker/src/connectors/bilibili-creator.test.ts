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

const dynamic = (overrides: Record<string, unknown> = {}) => ({
  id_str: '1000000001',
  type: 'DYNAMIC_TYPE_WORD',
  modules: {
    module_author: {
      mid: 946974,
      name: '影视飓风',
      pub_ts: 1786093200,
    },
    module_dynamic: {
      desc: {
        text: '我们发布了完整的 AI 视频工作流说明，包含镜头规划、模型选择、参数取舍与复现方法。',
      },
      major: null,
    },
    module_stat: {
      comment: { count: 12 },
      forward: { count: 5 },
      like: { count: 88 },
    },
  },
  ...overrides,
});

describe('BilibiliCreatorConnector', () => {
  it('collects videos, dynamics, articles, and repost context with stable mid filtering', async () => {
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
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: {
          has_more: true,
          offset: 'next-page',
          items: [
            dynamic(),
            dynamic({
              id_str: '1000000002',
              type: 'DYNAMIC_TYPE_ARTICLE',
              modules: {
                module_author: { mid: 946974, name: '影视飓风', pub_ts: 1786093100 },
                module_dynamic: {
                  desc: { text: '这篇专栏系统整理了制作流程。' },
                  major: {
                    type: 'MAJOR_TYPE_ARTICLE',
                    article: {
                      id: 987654,
                      title: '从脚本到成片：AI 视频制作完整复盘',
                      desc: '包括提示词、镜头衔接、声音设计与失败案例。',
                      jump_url: '//www.bilibili.com/read/cv987654',
                    },
                  },
                },
                module_stat: {
                  comment: { count: 20 }, forward: { count: 9 }, like: { count: 120 },
                },
              },
            }),
            dynamic({
              id_str: '1000000003',
              type: 'DYNAMIC_TYPE_FORWARD',
              modules: {
                module_author: { mid: 946974, name: '影视飓风', pub_ts: 1786093000 },
                module_dynamic: {
                  desc: { text: '' },
                  major: null,
                },
                module_stat: {
                  comment: { count: 8 }, forward: { count: 3 }, like: { count: 66 },
                },
              },
              orig: dynamic({
                id_str: '999999999',
                modules: {
                  module_author: { mid: 123456, name: '原作者', pub_ts: 1786000000 },
                  module_dynamic: {
                    desc: { text: '原帖公开了完整工程、评测数据、运行参数和复现实验记录。' },
                    major: null,
                  },
                  module_stat: {
                    comment: { count: 4 }, forward: { count: 2 }, like: { count: 30 },
                  },
                },
              }),
            }),
            dynamic({
              id_str: '1000000004',
              modules: {
                module_author: { mid: 123, name: '其他账号', pub_ts: 1786093000 },
                module_dynamic: {
                  desc: { text: '不应进入该博主归档的其他账号内容。' },
                  major: null,
                },
                module_stat: {
                  comment: { count: 0 }, forward: { count: 0 }, like: { count: 0 },
                },
              },
            }),
          ],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { has_more: false, offset: '', items: [] },
      }), { status: 200 }));
    const connector = new BilibiliCreatorConnector({
      mid: '946974',
      pageBudget: 2,
      now: () => new Date('2026-08-07T12:00:00.000Z'),
    }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    expect(result.requestCount).toBe(7);
    expect(result.identity).toEqual({
      displayName: '影视飓风',
      profileUrl: 'https://space.bilibili.com/946974',
      handle: 'UID 946974',
    });
    expect(result.candidates).toHaveLength(6);
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
    expect(result.candidates.find((item) => item.externalId === '1000000001')).toMatchObject({
      sourceType: 'social',
      url: 'https://t.bilibili.com/1000000001',
      creatorContext: { contentType: 'original' },
      engagement: { comments: 12, reposts: 5, likes: 88 },
    });
    expect(result.candidates.find((item) => item.externalId === '1000000002')).toMatchObject({
      sourceType: 'web',
      url: 'https://www.bilibili.com/read/cv987654',
      title: '从脚本到成片：AI 视频制作完整复盘',
      creatorContext: { contentType: 'original' },
    });
    expect(result.candidates.find((item) => item.externalId === '1000000003')).toMatchObject({
      sourceType: 'social',
      url: 'https://t.bilibili.com/1000000003',
      creatorContext: {
        contentType: 'repost',
        originalAuthorName: '原作者',
        originalAuthorHandle: 'UID 123456',
        originalContentId: '999999999',
        originalContentUrl: 'https://t.bilibili.com/999999999',
      },
    });
    expect(result.candidates.find((item) => item.externalId === '1000000003')?.content).toContain(
      '原帖公开了完整工程',
    );
    const signedUrls = fetcher.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname === '/x/web-interface/wbi/search/type');
    expect(signedUrls).toHaveLength(3);
    expect(signedUrls.every((url) => /^[a-f0-9]{32}$/.test(url.searchParams.get('w_rid') ?? ''))).toBe(true);
    expect(signedUrls[2]!.searchParams.get('page')).toBe('2');
    const dynamicUrls = fetcher.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname === '/x/polymer/web-dynamic/v1/feed/space');
    expect(dynamicUrls).toHaveLength(2);
    expect(dynamicUrls[0]!.searchParams.get('host_mid')).toBe('946974');
    expect(dynamicUrls[1]!.searchParams.get('offset')).toBe('next-page');
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
