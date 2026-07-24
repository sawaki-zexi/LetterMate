import type { DiscoveryCandidate, DiscoveryResult } from '@lettermate/contracts';
import { canonicalizeUrl } from './url.js';

export class DiscoveryValidationError extends Error {
  constructor(
    public readonly code: 'AI_CITATIONS_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'DiscoveryValidationError';
  }
}

export const normalizeKeyword = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

function canonicalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return canonicalizeUrl(value);
  } catch {
    return null;
  }
}

export function validateDiscoveryResult(result: DiscoveryResult): DiscoveryCandidate[] {
  const citations = new Set(
    result.citations.flatMap((url) => {
      const canonical = canonicalHttpUrl(url);
      return canonical ? [canonical] : [];
    }),
  );
  const valid = result.items.filter((item) =>
    item.sourceUrls.every((url) => {
      const canonical = canonicalHttpUrl(url);
      return canonical !== null && citations.has(canonical);
    }),
  );

  if (result.items.length > 0 && valid.length === 0) {
    throw new DiscoveryValidationError(
      'AI_CITATIONS_MISSING',
      '搜索结果缺少可验证的原始链接',
    );
  }

  return valid;
}
