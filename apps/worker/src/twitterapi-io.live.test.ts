import { validateSourceCandidate } from '@lettermate/domain';
import { describe, expect, it } from 'vitest';
import { TwitterApiIoConnector } from './connectors/twitterapi-io.js';
import type { SourceQueryPlan } from './connectors/types.js';
import { buildKeywordPolicy } from './keyword-policy.js';

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const apiKey = process.env.TWITTERAPI_IO_API_KEY;
const enabled = process.env.RUN_LIVE_TWITTERAPI_IO_TESTS === '1' && Boolean(apiKey);

describe.skipIf(!enabled)('TwitterAPI.io live discovery', () => {
  it('returns schema-valid public X candidates without exposing the API key', async () => {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1_000);
    const plan: SourceQueryPlan = {
      keyword: 'OpenAI',
      matchPolicy: buildKeywordPolicy('OpenAI'),
      expandedTerms: ['OpenAI'],
      queries: ['OpenAI'],
      sourceTypes: ['social'],
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      maxCandidates: 5,
    };
    const connector = new TwitterApiIoConnector({
      apiKey: apiKey!,
      pageBudget: 1,
      queryBudget: 1,
      threadBudget: 1,
    });

    const result = await connector.search(plan, new AbortController().signal);
    const valid = result.candidates.map(validateSourceCandidate);

    expect(valid.length).toBeGreaterThan(0);
    expect(valid.every((candidate) => candidate.platform === 'X')).toBe(true);
    expect(valid.every((candidate) => candidate.proof.kind === 'api_record')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(apiKey!);
  }, 120_000);
});
