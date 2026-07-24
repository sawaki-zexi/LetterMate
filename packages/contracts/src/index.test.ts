import { describe, expect, it } from 'vitest';
import {
  discoveryResultSchema,
  topicInputSchema,
} from './index.js';

describe('AI discovery contracts', () => {
  it('accepts exactly one trimmed keyword', () => {
    expect(topicInputSchema.parse({ keyword: '  AI Agent  ' })).toEqual({ keyword: 'AI Agent' });
    expect(() => topicInputSchema.parse({ keyword: '' })).toThrow();
    expect(() => topicInputSchema.parse({ keyword: 'x'.repeat(101) })).toThrow();
  });

  it('requires hot or quality items with summary, reason and source URLs', () => {
    const result = discoveryResultSchema.parse({
      citations: ['https://example.com/release'],
      items: [
        {
          kind: 'quality',
          title: 'Agent release',
          summary: '这是中文摘要。',
          reason: '内容提供了完整实现细节。',
          sourceUrls: ['https://example.com/release'],
          publishedAt: '2026-07-24T06:30:00.000Z',
        },
      ],
    });

    expect(result.items[0]?.kind).toBe('quality');
  });

  it('rejects obsolete trust classifications', () => {
    expect(() =>
      discoveryResultSchema.parse({
        citations: ['https://example.com/release'],
        items: [
          {
            kind: 'confirmed',
            title: 'Agent release',
            summary: '这是中文摘要。',
            reason: '错误的旧状态。',
            sourceUrls: ['https://example.com/release'],
            publishedAt: null,
          },
        ],
      }),
    ).toThrow();
  });
});
