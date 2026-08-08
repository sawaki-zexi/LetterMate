import { validateSourceCandidate } from '@lettermate/domain';
import { describe, expect, it } from 'vitest';
import { BilibiliCreatorConnector } from './connectors/bilibili-creator.js';
import type { SourceQueryPlan } from './connectors/types.js';
import { buildKeywordPolicy } from './keyword-policy.js';

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const mid = process.env.BILIBILI_LIVE_MID;
const enabled = process.env.RUN_LIVE_BILIBILI_TESTS === '1' && /^\d{1,20}$/.test(mid ?? '');

describe.skipIf(!enabled)('Bilibili creator live discovery', () => {
  it('returns schema-valid public creator content including a dynamic or article', async () => {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 30 * 24 * 60 * 60 * 1_000);
    const plan: SourceQueryPlan = {
      keyword: mid!,
      matchPolicy: buildKeywordPolicy(mid!),
      expandedTerms: [],
      queries: [mid!],
      sourceTypes: ['video', 'social', 'web'],
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      maxCandidates: 30,
    };
    const connector = new BilibiliCreatorConnector({ mid: mid!, pageBudget: 1 });

    const result = await connector.search(plan, new AbortController().signal);
    const valid = result.candidates.map(validateSourceCandidate);

    expect(result.identity?.profileUrl).toBe(`https://space.bilibili.com/${mid}`);
    expect(valid.length).toBeGreaterThan(0);
    expect(valid.every((candidate) => candidate.platform === 'Bilibili')).toBe(true);
    expect(valid.some((candidate) => (
      candidate.sourceType === 'social'
      || candidate.canonicalUrl.includes('/read/')
      || candidate.canonicalUrl.includes('/opus/')
    ))).toBe(true);
  }, 120_000);
});
