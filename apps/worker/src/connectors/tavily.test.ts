import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { TavilyConnector } from './tavily.js';

const plan: SourceQueryPlan = {
  matchPolicy: buildKeywordPolicy('AI agent'),
  keyword: 'AI agent',
  expandedTerms: [],
  queries: ['AI agent release'],
  sourceTypes: ['web'],
  windowStart: '2026-07-20T00:00:00.000Z',
  windowEnd: '2026-07-27T00:00:00.000Z',
  maxCandidates: 5,
};

describe('TavilyConnector', () => {
  it('sends the API key as a bearer token and maps search results', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [
        {
          title: 'Agent release',
          url: 'https://example.com/release',
          content: '  A concise result excerpt.  ',
          published_date: '2026-07-25T12:00:00Z',
        },
        { title: 'Invalid URL', url: 'javascript:alert(1)', content: 'ignore' },
      ],
    }), { status: 200 }));
    const connector = new TavilyConnector({
      apiKey: 'tavily-test-key',
      baseUrl: 'https://tavily.example/search',
    }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    expect(fetcher).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe('https://tavily.example/search');
    expect(requestInit.headers).toMatchObject({ authorization: 'Bearer tavily-test-key' });
    const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      query: 'AI agent release',
      search_depth: 'basic',
      start_date: '2026-07-20',
      end_date: '2026-07-27',
      max_results: 5,
    });
    expect(result).toMatchObject({ requestCount: 1 });
    expect(result.candidates).toMatchObject([{
      connectorId: 'search-tavily',
      platform: 'Tavily',
      url: 'https://example.com/release',
      title: 'Agent release',
      excerpt: 'A concise result excerpt.',
      publishedAt: '2026-07-25T12:00:00.000Z',
      proof: { kind: 'api_record', connectorId: 'search-tavily' },
    }]);
  });

  it('is disabled without a key and maps authentication failures safely', async () => {
    expect(new TavilyConnector({}).isEnabled()).toBe(false);
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const connector = new TavilyConnector({ apiKey: 'bad-key' }, fetcher as typeof fetch);

    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_AUTH_FAILED',
      retryable: false,
    });
  });
});
