import { validateSourceCandidate } from '@lettermate/domain';
import { describe, expect, it } from 'vitest';
import { OpenRouterSearchConnector } from './connectors/openrouter-search.js';
import type { SourceQueryPlan } from './connectors/types.js';
import { buildKeywordPolicy } from './keyword-policy.js';
import { OpenRouterAiGateway } from './openrouter-gateway.js';

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const apiKey = process.env.AI_API_KEY;
const enabled = process.env.RUN_LIVE_AI_TESTS === '1' && Boolean(apiKey);

describe.skipIf(!enabled)('OpenRouter live discovery', () => {
  it('expands a topic and returns citation-backed web candidates', async () => {
    const model = process.env.AI_MODEL ?? 'openrouter/auto';
    const gateway = new OpenRouterAiGateway({
      apiKey: apiKey!,
      model,
      webSearch: true,
      timeoutMs: 120_000,
    });
    const expanded = await gateway.expandTopic({ keyword: '人工智能' });
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 30 * 24 * 60 * 60 * 1_000);
    const plan: SourceQueryPlan = {
      keyword: '人工智能',
      matchPolicy: buildKeywordPolicy('人工智能'),
      expandedTerms: expanded.terms,
      queries: expanded.searchQueries.slice(0, 3),
      sourceTypes: ['web'],
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      maxCandidates: 10,
    };
    const connector = new OpenRouterSearchConnector({
      apiKey: apiKey!,
      model,
      webSearch: true,
      timeoutMs: 120_000,
    });
    const result = await connector.search(plan, new AbortController().signal);
    const valid = result.candidates.map(validateSourceCandidate);

    expect(expanded.terms.length).toBeGreaterThan(0);
    expect(expanded.searchQueries.length).toBeGreaterThan(0);
    expect(valid.length).toBeGreaterThan(0);
    expect(valid.every((candidate) => candidate.proof.kind === 'ai_citation')).toBe(true);
    expect(valid.every((candidate) => candidate.proof.connectorId === connector.id)).toBe(true);
  }, 180_000);
});
