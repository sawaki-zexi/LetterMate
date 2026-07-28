import { validateSourceCandidate, type ValidatedSourceCandidate } from '@lettermate/domain';
import { describe, expect, it, vi } from 'vitest';
import { buildKeywordPolicy } from './keyword-policy.js';
import { QualityPipeline, type QualityAiGateway } from './quality-pipeline.js';

const candidate = (id: string, overrides: Partial<ValidatedSourceCandidate> = {}) => validateSourceCandidate({
  connectorId: 'search-brave', sourceType: 'web', platform: 'Brave Search', externalId: id,
  url: `https://example${id}.com/article`, title: `Agents article ${id}`, content: null,
  excerpt: 'Search excerpt that needs complete article content.', authorName: null, authorHandle: null,
  publishedAt: '2026-07-25T12:00:00.000Z', language: 'en', engagement: {},
  proof: { kind: 'api_record', connectorId: 'search-brave', externalId: id }, ...overrides,
});

const composed = (source: ValidatedSourceCandidate) => ({
  kind: 'quality' as const, title: source.title ?? 'Title', summary: '中文高质量摘要', reason: '包含新的技术细节',
  sourceUrls: [source.canonicalUrl], publishedAt: source.publishedAt, sourceType: source.sourceType,
  platform: source.platform, authorName: source.authorName, authorHandle: source.authorHandle,
  externalId: source.externalId, provenanceKind: source.proof.kind,
});

const gateway = (overrides: Partial<QualityAiGateway> = {}): QualityAiGateway => ({
  evaluateCandidates: async ({ candidates }) => candidates.map(({ id }) => ({
    id, accepted: true, kind: 'quality', reason: 'substantive', claimSupport: 'supported',
  })),
  composeItems: async ({ candidates }) => candidates.map(({ candidate: item }) => composed(item)),
  ...overrides,
});

const agentsPolicy = buildKeywordPolicy('agents');

describe('QualityPipeline', () => {
  it('enriches only body-dependent web candidates before assessment', async () => {
    const web = candidate('1');
    const social = candidate('2', {
      connectorId: 'twitterapi-io', sourceType: 'social', platform: 'X', externalId: '2',
      url: 'https://x.com/project/status/2', title: null, content: 'Agents: we released v2 today.', excerpt: null,
      authorName: 'Project', authorHandle: 'project',
      proof: { kind: 'api_record', connectorId: 'twitterapi-io', externalId: '2' },
    });
    const fetchText = vi.fn().mockResolvedValue({
      finalUrl: web.canonicalUrl, title: 'Full article', contentType: 'text/html',
      text: 'A complete article body with architecture, migration details, measurements, and limitations.',
    });
    const evaluateCandidates = vi.fn(async ({ candidates }) => candidates.map(({ id }: { id: string }) => ({
      id, accepted: true, kind: 'quality' as const, reason: 'new', claimSupport: 'supported' as const,
    })));
    const pipeline = new QualityPipeline({ fetchText } as never, gateway({ evaluateCandidates }));

    const result = await pipeline.run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates: [web, social], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' });

    expect(fetchText).toHaveBeenCalledOnce();
    expect(fetchText).toHaveBeenCalledWith(web.canonicalUrl, undefined);
    expect(evaluateCandidates).toHaveBeenCalledOnce();
    expect(evaluateCandidates.mock.calls[0]![0].candidates[0].text).toContain('complete article body');
    expect(result).toHaveLength(2);
  });

  it('fetches a body before rejecting a matching web candidate with no content or excerpt', async () => {
    const web = candidate('bodyless', { title: 'Agents', content: null, excerpt: null });
    const fetchText = vi.fn().mockResolvedValue({
      finalUrl: web.canonicalUrl,
      title: 'Recovered article',
      contentType: 'text/html',
      text: 'Recovered architecture details, migration steps, measurements, and limitations.',
    });
    const evaluateCandidates = vi.fn(async ({ candidates }) => candidates.map(({ id }: { id: string }) => ({
      id, accepted: true, kind: 'quality' as const, reason: 'new', claimSupport: 'supported' as const,
    })));

    const result = await new QualityPipeline(
      { fetchText } as never,
      gateway({ evaluateCandidates }),
    ).run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates: [web], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' });

    expect(fetchText).toHaveBeenCalledOnce();
    expect(evaluateCandidates).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
  });

  it('deduplicates matching fetched bodies before AI review', async () => {
    const first = candidate('mirror-a', { content: null, excerpt: null, title: 'Agents shared release' });
    const second = candidate('mirror-b', { content: null, excerpt: null, title: ' agents shared release ' });
    const fetchText = vi.fn().mockResolvedValue({
      finalUrl: first.canonicalUrl,
      title: 'Agents shared release',
      contentType: 'text/html',
      text: 'The release adds offline support, deterministic synchronization, and a complete migration guide.',
    });
    const evaluateCandidates = vi.fn(async ({ candidates }) => candidates.map(({ id }: { id: string }) => ({
      id, accepted: true, kind: 'quality' as const, reason: 'new', claimSupport: 'supported' as const,
    })));

    await new QualityPipeline({ fetchText } as never, gateway({ evaluateCandidates })).run({
      keyword: 'agents', matchPolicy: agentsPolicy, candidates: [first, second], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z',
    });

    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(evaluateCandidates.mock.calls[0]![0].candidates).toHaveLength(1);
  });

  it('assesses large candidate sets in batches of at most thirty', async () => {
    const candidates = Array.from({ length: 35 }, (_, index) => candidate(String(index), {
      content: `Substantive candidate ${index} with architecture, measurements, migration details, and limitations.`,
    }));
    const evaluateCandidates = vi.fn(async ({ candidates: batch }) => batch.map(({ id }: { id: string }) => ({
      id, accepted: true, kind: 'quality' as const, reason: 'new', claimSupport: 'supported' as const,
    })));

    await new QualityPipeline(
      { fetchText: vi.fn() } as never,
      gateway({ evaluateCandidates }),
    ).run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates, historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' });

    expect(evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(evaluateCandidates.mock.calls.map(([input]) => input.candidates.length)).toEqual([30, 5]);
  });

  it('limits the full text sent to final composition', async () => {
    const source = candidate('large', { content: 'x'.repeat(100_000) });
    const composeItems = vi.fn(async ({ candidates }) => candidates.map(
      ({ candidate: item }: { candidate: ValidatedSourceCandidate }) => composed(item),
    ));

    await new QualityPipeline(
      { fetchText: vi.fn() } as never,
      gateway({ composeItems }),
    ).run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates: [source], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' });

    const composedSource = composeItems.mock.calls[0]![0].candidates[0].candidate;
    expect(composedSource.content?.length).toBeLessThanOrEqual(12_000);
  });

  it('reserves composition source text for every selected candidate', async () => {
    const sources = Array.from({ length: 8 }, (_, index) => candidate(`budget-${index}`, {
      content: `${index}`.repeat(20_000),
    }));
    const composeItems = vi.fn(async ({ candidates }) => candidates.map(
      ({ candidate: item }: { candidate: ValidatedSourceCandidate }) => composed(item),
    ));

    await new QualityPipeline(
      { fetchText: vi.fn() } as never,
      gateway({ composeItems }),
    ).run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates: sources, historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' });

    const compositionCandidates = composeItems.mock.calls[0]![0].candidates;
    expect(compositionCandidates).toHaveLength(8);
    expect(compositionCandidates.every(({
      candidate: item,
    }: { candidate: ValidatedSourceCandidate }) => (
      (item.title?.length ?? 0) + (item.content?.length ?? 0) + (item.excerpt?.length ?? 0) > 0
    ))).toBe(true);
  });

  it('fetches full content when a feed only provides a short description', async () => {
    const feed = candidate('short-feed', {
      connectorId: 'rss', sourceType: 'feed', platform: 'Project Feed',
      content: 'Short description.', excerpt: null,
      proof: {
        kind: 'feed_entry', connectorId: 'rss',
        feedUrl: 'https://example.com/feed.xml', entryId: 'short-feed',
      },
    });
    const fetchText = vi.fn().mockResolvedValue({
      finalUrl: feed.canonicalUrl, title: feed.title, contentType: 'text/html',
      text: 'Complete release details with architecture, measurements, migration steps, and limitations.',
    });
    const evaluateCandidates = vi.fn(async ({ candidates }) => candidates.map(({ id }: { id: string }) => ({
      id, accepted: true, kind: 'quality' as const, reason: 'new', claimSupport: 'supported' as const,
    })));

    await new QualityPipeline({ fetchText } as never, gateway({ evaluateCandidates })).run({
      keyword: 'agents', matchPolicy: agentsPolicy, candidates: [feed], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z',
    });

    expect(fetchText).toHaveBeenCalledWith(feed.canonicalUrl, undefined);
    expect(evaluateCandidates.mock.calls[0]![0].candidates[0].text)
      .toContain('Complete release details');
  });

  it('rejects low-value, duplicate, and historical candidates before AI review', async () => {
    const accepted = candidate('1', { content: 'A substantive article with detailed architecture, benchmarks, migration steps, and limitations.' });
    const lowValue = candidate('search', { url: 'https://low.example/search?q=agents', content: 'thin' });
    const duplicate = validateSourceCandidate({ ...accepted, connectorId: 'rss', proof: {
      kind: 'feed_entry', connectorId: 'rss', feedUrl: 'https://example1.com/feed', entryId: 'duplicate',
    } });
    const historical = candidate('3', { content: 'A substantive historical article with detailed implementation information.' });
    const evaluateCandidates = vi.fn(async ({ candidates }) => candidates.map(({ id }: { id: string }) => ({
      id, accepted: true, kind: 'quality' as const, reason: 'new', claimSupport: 'supported' as const,
    })));
    const pipeline = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({ evaluateCandidates }));

    await pipeline.run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates: [accepted, lowValue, duplicate, historical],
      historyUrls: [historical.canonicalUrl], windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' });

    expect(evaluateCandidates.mock.calls[0]![0].candidates).toHaveLength(1);
    expect(evaluateCandidates.mock.calls[0]![0].candidates[0].id).toBe(accepted.canonicalUrl);
  });

  it('rejects candidates outside the query match policy before AI review', async () => {
    const generic = candidate('generic', {
      title: 'The latest GPT models compared',
      content: 'A substantive roundup with architecture details, measurements, tradeoffs, and limitations.',
    });
    const evaluateCandidates = vi.fn(async ({ candidates }) => candidates.map(({ id }: { id: string }) => ({
      id,
      accepted: true,
      kind: 'quality' as const,
      reason: 'otherwise relevant',
      claimSupport: 'supported' as const,
    })));
    const pipeline = new QualityPipeline(
      { fetchText: vi.fn() } as never,
      gateway({ evaluateCandidates }),
    );

    await expect(pipeline.run({
      keyword: 'gpt-5.7',
      matchPolicy: buildKeywordPolicy('gpt-5.7'),
      candidates: [generic],
      historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z',
      windowEnd: '2026-07-27T00:00:00.000Z',
    })).resolves.toEqual([]);

    expect(evaluateCandidates).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'conflicting'] as const)(
    'rejects otherwise accepted %s claims',
    async (claimSupport) => {
      const source = candidate(claimSupport, {
        title: `gpt-5.7 ${claimSupport} release`,
        content: 'A substantive candidate body with implementation details, measurements, and limitations.',
      });
      const composeItems = vi.fn(async ({ candidates }) => candidates.map(
        ({ candidate: item }: { candidate: ValidatedSourceCandidate }) => composed(item),
      ));
      const pipeline = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({
        evaluateCandidates: async () => [{
          id: source.canonicalUrl,
          accepted: true,
          kind: 'quality',
          reason: 'otherwise relevant',
          claimSupport,
        }],
        composeItems,
      }));

      await expect(pipeline.run({
        keyword: 'gpt-5.7',
        matchPolicy: buildKeywordPolicy('gpt-5.7'),
        candidates: [source],
        historyUrls: [],
        windowStart: '2026-07-20T00:00:00.000Z',
        windowEnd: '2026-07-27T00:00:00.000Z',
      })).resolves.toEqual([]);
      expect(composeItems).not.toHaveBeenCalled();
    },
  );

  it('allows empty success and rejects composed URLs outside the accepted pool', async () => {
    const source = candidate('1', { content: 'A substantive article with detailed architecture, benchmarks, migration steps, and limitations.' });
    const rejecting = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({
      evaluateCandidates: async () => [{
        id: source.canonicalUrl, accepted: false, kind: null, reason: 'low value',
        claimSupport: 'unsupported',
      }],
      composeItems: vi.fn(),
    }));
    await expect(rejecting.run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates: [source], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' })).resolves.toEqual([]);

    const inventing = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({
      composeItems: async () => [{ ...composed(source), sourceUrls: ['https://invented.example/article'] }],
    }));
    await expect(inventing.run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates: [source], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'QUALITY_RESPONSE_INVALID' });
  });

  it('rejects an incomplete AI assessment batch', async () => {
    const first = candidate('1', { content: 'A substantive article with detailed architecture, benchmarks, migration steps, and limitations.' });
    const second = candidate('2', { content: 'Another substantive article with implementation details, measurements, and tradeoffs.' });
    const pipeline = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({
      evaluateCandidates: async () => [{
        id: first.canonicalUrl, accepted: true, kind: 'quality', reason: 'new', claimSupport: 'supported',
      }],
    }));

    await expect(pipeline.run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates: [first, second], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'QUALITY_RESPONSE_INVALID' });
  });

  it('rejects an assessment that omits claim support', async () => {
    const source = candidate('missing-support', {
      content: 'A substantive article with implementation details, measurements, and tradeoffs.',
    });
    const pipeline = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({
      evaluateCandidates: async () => [{
        id: source.canonicalUrl,
        accepted: true,
        kind: 'quality',
        reason: 'new',
      }] as never,
    }));

    await expect(pipeline.run({ keyword: 'agents', matchPolicy: agentsPolicy, candidates: [source], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'QUALITY_RESPONSE_INVALID' });
  });
});
