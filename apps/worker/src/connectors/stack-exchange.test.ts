import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from '../keyword-policy.js';
import type { SourceQueryPlan } from './types.js';
import { StackExchangeConnector } from './stack-exchange.js';

const plan: SourceQueryPlan = {
  keyword: 'AI Agent', matchPolicy: buildKeywordPolicy('AI Agent'), expandedTerms: [],
  queries: ['AI Agent'], sourceTypes: ['community'],
  windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-07T00:00:00.000Z', maxCandidates: 5,
};

describe('StackExchangeConnector', () => {
  it('returns answered, substantive Stack Overflow questions with API proof', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [
      {
        question_id: 42, title: 'How do I build an AI Agent?',
        link: 'https://stackoverflow.com/questions/42/how-do-i-build-an-ai-agent',
        body: '<p>A detailed question about agent state and tool execution.</p>', tags: ['python', 'ai'],
        is_answered: true, answer_count: 2, score: 4, view_count: 100,
        last_activity_date: 1_754_500_800, owner: { display_name: 'Ada', user_id: 7 },
      },
      { question_id: 43, title: 'Unanswered', link: 'https://stackoverflow.com/questions/43/unanswered', is_answered: false, answer_count: 0 },
    ] }), { status: 200 }));
    const result = await new StackExchangeConnector(fetcher as typeof fetch)
      .search(plan, new AbortController().signal);

    expect(fetcher).toHaveBeenCalledOnce();
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get('site')).toBe('stackoverflow');
    expect(url.searchParams.get('filter')).toBe('withbody');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      connectorId: 'stack-overflow', platform: 'Stack Overflow', externalId: '42',
      authorName: 'Ada', engagement: { score: 4, answers: 2, views: 100 },
      proof: { kind: 'api_record', externalId: '42' },
    });
  });
});
