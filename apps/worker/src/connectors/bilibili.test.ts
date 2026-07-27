import { describe, expect, it, vi } from 'vitest';
import type { SourceQueryPlan } from './types.js';
import { BilibiliConnector } from './bilibili.js';

const plan: SourceQueryPlan = {
  keyword: '智能体', expandedTerms: [], queries: ['智能体'], sourceTypes: ['video'],
  windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z', maxCandidates: 5,
};

describe('BilibiliConnector', () => {
  it('normalizes public video search results', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { result: [{
      bvid: 'BV1example', title: '<em class="keyword">智能体</em>工程实践', description: '包含架构、迁移和评测细节。',
      author: '项目团队', mid: 123, pubdate: 1784980800, play: 1000, video_review: 25,
    }] } }), { status: 200 }));
    const result = await new BilibiliConnector({ timeoutMs: 1000 }, fetcher as typeof fetch)
      .search(plan, new AbortController().signal);

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://api.bilibili.com/x/web-interface/search/type');
    expect(url.searchParams.get('keyword')).toBe('智能体');
    expect(result).toMatchObject({ requestCount: 1, candidates: [expect.objectContaining({
      connectorId: 'bilibili', sourceType: 'video', platform: 'Bilibili', externalId: 'BV1example',
      url: 'https://www.bilibili.com/video/BV1example', title: '智能体工程实践',
      content: '包含架构、迁移和评测细节。', authorName: '项目团队', authorHandle: '123',
      engagement: { views: 1000, comments: 25 },
      proof: { kind: 'api_record', connectorId: 'bilibili', externalId: 'BV1example' },
    })] });
  });

  it('disables itself after an access-control response', async () => {
    const connector = new BilibiliConnector({}, vi.fn().mockResolvedValue(new Response('', { status: 412 })) as unknown as typeof fetch);
    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_ACCESS_RESTRICTED', retryable: false,
    });
    expect(connector.isEnabled()).toBe(false);
  });

  it('aborts requests at its strict timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    try {
      const connector = new BilibiliConnector({ timeoutMs: 50 }, vi.fn(async (_url, init) => {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      }) as unknown as typeof fetch);
      const pending = connector.search(plan, new AbortController().signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CONNECTOR_TIMEOUT', retryable: true });
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
