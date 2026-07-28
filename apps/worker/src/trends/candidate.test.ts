import { describe, expect, it } from 'vitest';
import { createTrendCandidate, isoFromUnixSeconds } from './candidate.js';

describe('safe trend candidate construction', () => {
  const valid = {
    sourceId: 'source', platform: 'Platform', externalId: 'external', title: 'Title',
    url: 'https://example.com/trend', publishedAt: null,
  };

  it('rejects overlong fields and credential-bearing URLs per item', () => {
    expect(createTrendCandidate({ ...valid, title: 'x'.repeat(501) })).toBeNull();
    expect(createTrendCandidate({ ...valid, externalId: 'x'.repeat(501) })).toBeNull();
    expect(createTrendCandidate({ ...valid, url: `https://example.com/${'x'.repeat(2_100)}` })).toBeNull();
    expect(createTrendCandidate({ ...valid, url: 'https://user:password@example.com/trend' })).toBeNull();
  });

  it('converts only representable finite Unix timestamps', () => {
    expect(isoFromUnixSeconds(1_785_196_800)).toBe('2026-07-28T00:00:00.000Z');
    expect(isoFromUnixSeconds(Number.POSITIVE_INFINITY)).toBeNull();
    expect(isoFromUnixSeconds(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});
