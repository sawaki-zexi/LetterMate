import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { BingConnector } from './bing.js';

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

describe('BingConnector', () => {
  it('searches the public China Bing page without a key and extracts safe links', async () => {
    const encoded = Buffer.from('https://example.org/redirected').toString('base64url');
    const html = `<ol id="b_results">
      <li class="b_algo"><h2><a href="https://example.com/release">Agent release</a></h2>
        <div class="b_caption"><p>  A result excerpt. </p></div></li>
      <li class="b_algo"><h2><a href="https://cn.bing.com/ck/a?u=a1${encoded}">Redirected</a></h2></li>
      <li class="b_algo"><h2><a href="javascript:alert(1)">Unsafe</a></h2></li>
    </ol>`;
    const fetcher = vi.fn().mockResolvedValue(new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const connector = new BingConnector({ baseUrl: 'https://cn.bing.com/search' }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    expect(fetcher).toHaveBeenCalledOnce();
    const requestUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get('q')).toBe('AI agent release');
    expect(requestUrl.searchParams.get('cc')).toBe('cn');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ 'user-agent': 'Mozilla/5.0' }),
    });
    expect(result).toMatchObject({ requestCount: 1 });
    expect(result.candidates).toMatchObject([
      {
        connectorId: 'search-bing',
        platform: 'Bing (China)',
        url: 'https://example.com/release',
        title: 'Agent release',
        excerpt: 'A result excerpt.',
      },
      {
        connectorId: 'search-bing',
        url: 'https://example.org/redirected',
        title: 'Redirected',
      },
    ]);
  });

  it('maps a Bing bot challenge to a retryable rate-limit failure', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>captcha verify you are human</html>', { status: 200 }));
    const connector = new BingConnector({}, fetcher as typeof fetch);

    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_RATE_LIMITED',
      retryable: true,
    });
  });

  it('can be disabled explicitly', async () => {
    const fetcher = vi.fn();
    const connector = new BingConnector({ enabled: false }, fetcher as typeof fetch);

    expect(connector.isEnabled()).toBe(false);
    await expect(connector.search(plan, new AbortController().signal)).resolves.toEqual({
      candidates: [], requestCount: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
