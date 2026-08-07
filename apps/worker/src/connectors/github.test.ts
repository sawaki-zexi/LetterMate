import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { GitHubConnector } from './github.js';

const plan: SourceQueryPlan = {
  matchPolicy: buildKeywordPolicy('agent runtime'),
  keyword: 'agent runtime', expandedTerms: [], queries: ['agent runtime'], sourceTypes: ['code'],
  windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z', maxCandidates: 6,
};

const searchResult = { total_count: 1, items: [{
  node_id: 'repo-node', full_name: 'org/agent', html_url: 'https://github.com/org/agent',
  description: 'Durable agent runtime.', pushed_at: '2026-07-25T10:00:00Z', stargazers_count: 123,
  owner: { login: 'org' },
}] };
const releases = [{
  node_id: 'release-node', html_url: 'https://github.com/org/agent/releases/tag/v2', name: 'Version 2',
  body: 'Checkpoint recovery and migration notes.', published_at: '2026-07-24T11:00:00Z',
  draft: false, prerelease: false, author: { login: 'maintainer' },
}];

describe('GitHubConnector', () => {
  it('uses repository search as a seed and emits substantive releases only', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(searchResult), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(releases), { status: 200 }));
    const connector = new GitHubConnector({ token: undefined, repositoryBudget: 1 }, fetcher as typeof fetch);

    const result = await connector.search(plan, new AbortController().signal);

    expect(connector.isEnabled()).toBe(true);
    const searchUrl = new URL(String(fetcher.mock.calls[0]![0]));
    expect(searchUrl.origin + searchUrl.pathname).toBe('https://api.github.com/search/repositories');
    expect(searchUrl.searchParams.get('q')).toBe('agent runtime pushed:>=2026-07-20');
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('authorization');
    expect(result).toMatchObject({ requestCount: 2, candidates: [
      expect.objectContaining({
        externalId: 'release-node', url: 'https://github.com/org/agent/releases/tag/v2',
        title: 'Version 2', content: 'Checkpoint recovery and migration notes.', authorHandle: 'maintainer',
        proof: { kind: 'api_record', connectorId: 'github', externalId: 'release-node' },
      }),
    ] });
    expect(result.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://github.com/org/agent' }),
    ]));
  });

  it('adds an optional bearer token without exposing it in rate-limit errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"message":"private gh-secret"}', {
      status: 403, headers: { 'x-ratelimit-remaining': '0' },
    }));
    const connector = new GitHubConnector({ token: 'gh-secret' }, fetcher as typeof fetch);

    try {
      await connector.search(plan, new AbortController().signal);
      throw new Error('expected request to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONNECTOR_RATE_LIMITED', retryable: true });
      expect((error as Error).message).not.toContain('gh-secret');
    }
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers)
      .toHaveProperty('authorization', 'Bearer gh-secret');
  });

  it('maps malformed GitHub JSON shapes to a safe response error', async () => {
    const connector = new GitHubConnector({}, vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ node_id: null }] }), { status: 200 }),
    ) as unknown as typeof fetch);

    await expect(connector.search(plan, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONNECTOR_RESPONSE_INVALID', retryable: false,
    });
  });
});
