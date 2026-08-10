import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import { DigestBriefGenerator } from './digest-brief-generator.js';
import type { DigestSnapshot } from './digest-service.js';

const snapshots: DigestSnapshot[] = [{
  contentKey: 'https://example.com/model',
  position: 0,
  title: 'GPT-5.7 模型更新',
  summary: '官方说明新增了工具调用能力。',
  reason: '这是关注版本的直接更新。',
  sourceUrl: 'https://example.com/model',
  citationUrls: ['https://example.com/model', 'https://example.com/changelog'],
  platform: 'OpenAI',
  publishedAt: new Date('2026-08-10T02:00:00.000Z'),
  evidence: '这是关注版本的直接更新。',
  uncertainty: '邮件摘要不替代完整原文。',
  followUp: '继续关注后续兼容性说明。',
}];

describe('DigestBriefGenerator', () => {
  it('maps allowed source IDs back to frozen URLs without exposing URLs to the model', async () => {
    const composeDigestBriefs = vi.fn().mockResolvedValue([{
      id: 'item-1',
      conclusion: '官方已公布 GPT-5.7 的工具调用更新。',
      evidence: '输入摘要明确说明新增了工具调用能力。',
      uncertainty: '当前材料没有说明所有客户端的兼容范围。',
      followUp: '继续关注后续兼容性与迁移说明。',
      citationIds: ['item-1-source-2'],
    }]);

    const result = await new DigestBriefGenerator({ composeDigestBriefs }).generate({
      runId: 'run-1', userId: 'user-1', snapshots,
    });

    expect(result).toMatchObject({
      status: 'generated', errorCode: null, version: 'digest-brief-grounded-v1',
    });
    expect(result.items[0]).toMatchObject({
      summary: '官方已公布 GPT-5.7 的工具调用更新。',
      sourceUrl: 'https://example.com/changelog',
      citationUrls: ['https://example.com/changelog'],
    });
    expect(composeDigestBriefs).toHaveBeenCalledWith(expect.objectContaining({
      execution: { runId: 'run-1', userId: 'user-1', runKind: 'digest' },
    }));
    const modelInput = composeDigestBriefs.mock.calls[0]?.[0].candidates;
    expect(JSON.stringify(modelInput)).not.toContain('https://');
    expect(modelInput[0].sources.map((source: { id: string }) => source.id)).toEqual([
      'item-1-source-1', 'item-1-source-2',
    ]);
  });

  it('falls back atomically when the model returns an unknown citation ID', async () => {
    const generator = new DigestBriefGenerator({
      composeDigestBriefs: vi.fn().mockResolvedValue([{
        id: 'item-1', conclusion: '结论', evidence: '证据', uncertainty: '不确定性',
        followUp: '后续关注', citationIds: ['item-2-source-1'],
      }]),
    });

    await expect(generator.generate({ runId: 'run-1', userId: 'user-1', snapshots }))
      .resolves.toEqual(expect.objectContaining({
        items: snapshots, status: 'fallback', errorCode: 'AI_RESPONSE_INVALID',
      }));
  });

  it('rejects duplicate outputs and generated URLs even through a permissive adapter', async () => {
    const generated = {
      id: 'item-1',
      conclusion: '请查看 https://untrusted.example 获取结论。',
      evidence: '这是一段中文证据。',
      uncertainty: '这是一段中文不确定性。',
      followUp: '这是一段中文后续关注。',
      citationIds: ['item-1-source-1'],
    };
    const generator = new DigestBriefGenerator({
      composeDigestBriefs: vi.fn().mockResolvedValue([generated, generated]),
    });

    await expect(generator.generate({ runId: 'run-1', userId: 'user-1', snapshots }))
      .resolves.toEqual(expect.objectContaining({
        items: snapshots, status: 'fallback', errorCode: 'AI_RESPONSE_INVALID',
      }));
  });

  it('keeps a readable fallback and safe error code when the provider fails', async () => {
    const generator = new DigestBriefGenerator({
      composeDigestBriefs: vi.fn().mockRejectedValue(
        new AiGatewayError('AI_RATE_LIMITED', 'rate limited', true),
      ),
    });

    await expect(generator.generate({ runId: 'run-1', userId: 'user-1', snapshots }))
      .resolves.toEqual(expect.objectContaining({
        items: snapshots, status: 'fallback', errorCode: 'AI_RATE_LIMITED',
      }));
  });

  it('uses the same fallback when AI is not configured', async () => {
    await expect(new DigestBriefGenerator().generate({
      runId: 'run-1', userId: 'user-1', snapshots,
    })).resolves.toEqual(expect.objectContaining({
      items: snapshots, status: 'fallback', errorCode: 'AI_NOT_CONFIGURED',
    }));
  });
});
