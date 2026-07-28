import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { SearchProviderConnector } from './search-provider.js';

const plan: SourceQueryPlan = {
  matchPolicy: buildKeywordPolicy('AI agent'),
  keyword: 'AI agent', expandedTerms: [], queries: ['AI agent', '智能体'], sourceTypes: ['web'],
  windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z', maxCandidates: 10,
};
const response = { web: { results: [{
  title: 'Agent release', url: 'https://example.com/release', description: 'Detailed release notes.',
  profile: { long_name: 'Example' }, page_age: '2026-07-25T12:00:00Z',
}] } };

describe('SearchProviderConnector', () => {
  it('searches Chinese and English queries with optional site constraints', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(response), { status: 200 }));
    const connector = new SearchProviderConnector({
      provider: 'brave', apiKey: 'search-key', siteConstraints: ['github.com'], pageBudget: 1,
    }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    expect(fetcher).toHaveBeenCalledTimes(4);
    const queries = fetcher.mock.calls.map(([value]) => new URL(String(value)).searchParams.get('q'));
    expect(queries).toEqual(['AI agent', 'AI agent site:github.com', '智能体', '智能体 site:github.com']);
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers)
      .toHaveProperty('x-subscription-token', 'search-key');
    expect(result.candidates[0]).toMatchObject({
      connectorId: 'search-brave', sourceType: 'web', platform: 'Brave Search',
      externalId: 'https://example.com/release', url: 'https://example.com/release',
      proof: { kind: 'api_record', connectorId: 'search-brave', externalId: 'https://example.com/release' },
    });
  });

  it('honors the configured page budget and rejects malformed URLs', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ web: { results: [{
      title: 'bad', url: 'javascript:alert(1)', description: 'bad',
    }] } }), { status: 200 }));
    const connector = new SearchProviderConnector({ provider: 'brave', apiKey: 'key', pageBudget: 2 }, fetcher as typeof fetch);

    await expect(connector.search({ ...plan, queries: ['one'] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'CONNECTOR_RESPONSE_INVALID', retryable: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
