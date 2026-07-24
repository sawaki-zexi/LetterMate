import { describe, expect, it } from 'vitest';
import { canonicalizeUrl } from './index.js';

describe('URL canonicalization', () => {
  it('removes tracking parameters while keeping content parameters', () => {
    expect(canonicalizeUrl('https://Example.com/news?id=42&utm_source=mail#top')).toBe(
      'https://example.com/news?id=42',
    );
  });
});
