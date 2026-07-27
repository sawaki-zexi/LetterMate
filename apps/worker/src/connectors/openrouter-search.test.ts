import { describe, expect, it, vi } from 'vitest';
import type { SourceQueryPlan } from './types.js';
import { OpenRouterSearchConnector } from './openrouter-search.js';

const plan: SourceQueryPlan = {
  keyword: 'agent runtime', expandedTerms: [], queries: ['agent runtime latest'], sourceTypes: ['web'],
  windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z', maxCandidates: 5,
};
const response = new Response(JSON.stringify({ choices: [{ message: {
  content: JSON.stringify({ results: [
    { url: 'https://example.com/release', title: 'Agent release', excerpt: 'Detailed release and migration notes.', publishedAt: '2026-07-25T12:00:00Z' },
    { url: 'https://invented.example/article', title: 'Invented', excerpt: 'Not cited.', publishedAt: null },
  ] }),
  annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/release', title: 'Agent release' } }],
} }] }), { status: 200 });

describe('OpenRouterSearchConnector', () => {
  it('uses Web Search and accepts only annotation-backed results', async () => {
    const fetcher = vi.fn().mockResolvedValue(response);
    const connector = new OpenRouterSearchConnector({
      apiKey: 'openrouter-key', model: 'openrouter/auto', webSearch: true, timeoutMs: 60_000,
    }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    const body = JSON.parse(String((fetcher.mock.calls[0]![1] as RequestInit).body));
    expect(body.plugins).toEqual([{ id: 'web' }]);
    expect(body.messages.at(-1).content).toContain('agent runtime latest');
    expect(result).toMatchObject({ requestCount: 1, candidates: [expect.objectContaining({
      connectorId: 'openrouter-search', sourceType: 'web', platform: 'Web', externalId: null,
      url: 'https://example.com/release', title: 'Agent release', excerpt: 'Detailed release and migration notes.',
      proof: { kind: 'ai_citation', connectorId: 'openrouter-search', citationUrl: 'https://example.com/release' },
    })] });
    expect(result.candidates).toHaveLength(1);
  });

  it('is disabled when Web Search or the API key is unavailable', () => {
    expect(new OpenRouterSearchConnector({ apiKey: undefined, model: 'm', webSearch: true, timeoutMs: 1_000 }).isEnabled()).toBe(false);
    expect(new OpenRouterSearchConnector({ apiKey: 'key', model: 'm', webSearch: false, timeoutMs: 1_000 }).isEnabled()).toBe(false);
  });
});
