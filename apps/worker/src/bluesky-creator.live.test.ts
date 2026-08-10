import { validateSourceCandidate } from '@lettermate/domain';
import { describe, expect, it } from 'vitest';
import { BlueskyCreatorConnector } from './connectors/bluesky-creator.js';
import type { SourceQueryPlan } from './connectors/types.js';
import { buildKeywordPolicy } from './keyword-policy.js';

try {
  process.loadEnvFile();
} catch {
  // Environment variables may already be supplied by the test runner.
}

const did = process.env.BLUESKY_LIVE_DID;
const enabled = process.env.RUN_LIVE_BLUESKY_TESTS === '1'
  && /^did:[a-z0-9]+:[a-z0-9:.%-]+$/i.test(did ?? '');

describe.skipIf(!enabled)('Bluesky creator live discovery', () => {
  it('returns source-valid public posts for the configured stable DID', async () => {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 30 * 24 * 60 * 60 * 1_000);
    const plan: SourceQueryPlan = {
      keyword: did!, matchPolicy: buildKeywordPolicy(did!), expandedTerms: [], queries: [did!],
      sourceTypes: ['social'], windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), maxCandidates: 30,
    };
    const result = await new BlueskyCreatorConnector({ did: did!, pageBudget: 1 })
      .search(plan, new AbortController().signal);
    const valid = result.candidates.map(validateSourceCandidate);

    expect(result.identity?.profileUrl).toMatch(/^https:\/\/bsky\.app\/profile\//);
    expect(valid.every((candidate) => candidate.platform === 'Bluesky')).toBe(true);
    expect(valid.every((candidate) => candidate.proof.kind === 'api_record')).toBe(true);
  }, 120_000);
});
