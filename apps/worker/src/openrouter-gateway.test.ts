import { describe, expect, it, vi } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import { OpenRouterAiGateway } from './openrouter-gateway.js';

const openRouterResponse = (content: string, annotations: unknown[] = []) =>
  new Response(
    JSON.stringify({
      id: 'generation-1',
      model: 'openrouter/auto',
      choices: [{ message: { role: 'assistant', content, annotations } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const makeGateway = (fetcher: typeof fetch) =>
  new OpenRouterAiGateway(
    {
      apiKey: 'secret-key',
      model: 'openrouter/auto',
      webSearch: true,
      timeoutMs: 60_000,
    },
    fetcher,
  );

describe('OpenRouterAiGateway', () => {
  it('sends the web plugin and normalizes URL citations', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      openRouterResponse(
        JSON.stringify({
          items: [
            {
              kind: 'hot',
              title: 'Release',
              summary: '这是中文摘要。',
              reason: '近期讨论明显增加。',
              sourceUrls: ['https://example.com/release'],
              publishedAt: null,
            },
          ],
        }),
        [
          {
            type: 'url_citation',
            url_citation: { url: 'https://example.com/release', title: 'Release' },
          },
          { type: 'unsupported_annotation' },
        ],
      ),
    );

    const result = await makeGateway(fetcher).discover({
      keyword: 'AI Agent',
      expandedTerms: ['智能体'],
      lookbackDays: 7,
      now: '2026-07-24T08:00:00.000Z',
    });

    expect(result.citations).toEqual(['https://example.com/release']);
    expect(result.items[0]).toMatchObject({ kind: 'hot', summary: '这是中文摘要。' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'openrouter/auto',
      plugins: [{ id: 'web' }],
    });
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret-key' });
  });

  it('expands one keyword without asking the user for synonyms', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      openRouterResponse(
        JSON.stringify({
          terms: ['AI agent', '智能体', 'agentic AI'],
          searchQueries: ['AI agent latest release', '智能体 最新进展'],
        }),
      ),
    );

    const result = await makeGateway(fetcher).expandTopic({ keyword: 'AI Agent' });

    expect(result.terms).toContain('智能体');
    const body = JSON.parse(String((fetcher.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.plugins).toBeUndefined();
    expect(body.messages.at(-1).content).toContain('AI Agent');
  });

  it('retries invalid JSON exactly once with a correction instruction', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(openRouterResponse('not-json'))
      .mockResolvedValueOnce(
        openRouterResponse(
          JSON.stringify({
            terms: ['AI agent'],
            searchQueries: ['AI agent latest'],
          }),
        ),
      );

    await expect(makeGateway(fetcher).expandTopic({ keyword: 'AI Agent' })).resolves.toMatchObject({
      terms: ['AI agent'],
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetcher.mock.calls[1] as [string, RequestInit])[1].body));
    expect(secondBody.messages.at(-1).content).toContain('JSON');
  });

  it('fails with AI_RESPONSE_INVALID after the correction response is invalid', async () => {
    const fetcher = vi.fn().mockResolvedValue(openRouterResponse('still-not-json'));

    await expect(makeGateway(fetcher).expandTopic({ keyword: 'AI' })).rejects.toMatchObject({
      code: 'AI_RESPONSE_INVALID',
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, 'AI_RATE_LIMITED', true],
    [401, 'AI_AUTH_FAILED', false],
    [404, 'AI_MODEL_UNAVAILABLE', false],
    [500, 'AI_UPSTREAM_UNAVAILABLE', true],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const gateway = makeGateway(
      vi.fn().mockResolvedValue(new Response('{"error":"secret-key"}', { status })),
    );

    await expect(gateway.expandTopic({ keyword: 'AI' })).rejects.toMatchObject({
      code,
      retryable,
    });
    await expect(gateway.expandTopic({ keyword: 'AI' })).rejects.not.toThrow(/secret-key/);
  });

  it('parses Retry-After seconds without exposing response content', async () => {
    const gateway = makeGateway(
      vi.fn().mockResolvedValue(
        new Response('private upstream details', {
          status: 429,
          headers: { 'retry-after': '15' },
        }),
      ),
    );

    try {
      await gateway.expandTopic({ keyword: 'AI' });
      throw new Error('expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AiGatewayError);
      expect(error).toMatchObject({ retryAfterMs: 15_000 });
      expect((error as Error).message).not.toContain('private upstream details');
    }
  });
});
