import { describe, expect, it } from 'vitest';
import { validateDiscoveryResult } from '@lettermate/domain';
import { OpenRouterAiGateway } from './openrouter-gateway.js';

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const apiKey = process.env.AI_API_KEY;
const enabled = process.env.RUN_LIVE_AI_TESTS === '1' && Boolean(apiKey);

describe.skipIf(!enabled)('OpenRouter live discovery', () => {
  it('returns citation-backed Chinese discoveries', async () => {
    const gateway = new OpenRouterAiGateway({
      apiKey: apiKey!,
      model: process.env.AI_MODEL ?? 'openrouter/auto',
      webSearch: true,
      timeoutMs: 120_000,
    });
    const expanded = await gateway.expandTopic({ keyword: '人工智能' });
    const result = await gateway.discover({
      keyword: '人工智能',
      expandedTerms: [...expanded.terms, ...expanded.searchQueries],
      lookbackDays: 30,
      now: new Date().toISOString(),
    });
    const valid = validateDiscoveryResult(result);
    expect(valid.length).toBeGreaterThan(0);
    expect(valid.every((item) => ['hot', 'quality'].includes(item.kind))).toBe(true);
    expect(valid.every((item) => item.summary.length > 0 && item.reason.length > 0)).toBe(true);
    expect(valid.every((item) => item.sourceUrls.every((url) => URL.canParse(url)))).toBe(true);
  }, 180_000);
});
