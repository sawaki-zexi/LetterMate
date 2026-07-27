import { describe, expect, it } from 'vitest';
import {
  DiscoveryValidationError,
  normalizeKeyword,
  validateDiscoveryResult,
} from './discovery.js';

describe('topic normalization', () => {
  it('normalizes equivalent keywords for uniqueness', () => {
    expect(normalizeKeyword('  ＡＩ Agent ')).toBe('ai agent');
  });
});

describe('discovery citation validation', () => {
  const sourceMetadata = {
    sourceType: 'web' as const,
    platform: 'Web',
    authorName: null,
    authorHandle: null,
    externalId: null,
    provenanceKind: 'ai_citation' as const,
  };

  it('keeps only candidates whose every URL is a citation', () => {
    const output = validateDiscoveryResult({
      citations: ['https://example.com/post?utm_source=x'],
      items: [
        {
          kind: 'hot',
          title: 'Valid',
          summary: '中文摘要',
          reason: '近期讨论集中',
          sourceUrls: ['https://example.com/post'],
          publishedAt: null,
          ...sourceMetadata,
        },
        {
          kind: 'quality',
          title: 'Invalid',
          summary: '中文摘要',
          reason: '内容深入',
          sourceUrls: ['https://invented.test/post'],
          publishedAt: null,
          ...sourceMetadata,
        },
      ],
    });

    expect(output).toHaveLength(1);
    expect(output[0]?.title).toBe('Valid');
  });

  it('accepts an explicit empty result', () => {
    expect(validateDiscoveryResult({ citations: [], items: [] })).toEqual([]);
  });

  it('rejects a non-empty model result when every item lacks citations', () => {
    expect(() =>
      validateDiscoveryResult({
        citations: [],
        items: [
          {
            kind: 'hot',
            title: 'No source',
            summary: '中文',
            reason: '热门',
            sourceUrls: ['https://invented.test'],
            publishedAt: null,
            ...sourceMetadata,
          },
        ],
      }),
    ).toThrow(DiscoveryValidationError);
  });
});
