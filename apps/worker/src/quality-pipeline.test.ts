import { validateSourceCandidate, type ValidatedSourceCandidate } from '@lettermate/domain';
import { describe, expect, it, vi } from 'vitest';
import { QualityPipeline, type QualityAiGateway } from './quality-pipeline.js';

const candidate = (id: string, overrides: Partial<ValidatedSourceCandidate> = {}) => validateSourceCandidate({
  connectorId: 'search-brave', sourceType: 'web', platform: 'Brave Search', externalId: id,
  url: `https://example${id}.com/article`, title: `Agent article ${id}`, content: null,
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
  evaluateCandidates: async ({ candidates }) => candidates.map(({ id }) => ({ id, accepted: true, kind: 'quality', reason: 'substantive' })),
  composeItems: async ({ candidates }) => candidates.map(({ candidate: item }) => composed(item)),
  ...overrides,
});

describe('QualityPipeline', () => {
  it('enriches only body-dependent web candidates before assessment', async () => {
    const web = candidate('1');
    const social = candidate('2', {
      connectorId: 'twitterapi-io', sourceType: 'social', platform: 'X', externalId: '2',
      url: 'https://x.com/project/status/2', title: null, content: 'We released v2 today.', excerpt: null,
      authorName: 'Project', authorHandle: 'project',
      proof: { kind: 'api_record', connectorId: 'twitterapi-io', externalId: '2' },
    });
    const fetchText = vi.fn().mockResolvedValue({
      finalUrl: web.canonicalUrl, title: 'Full article', contentType: 'text/html',
      text: 'A complete article body with architecture, migration details, measurements, and limitations.',
    });
    const evaluateCandidates = vi.fn(async ({ candidates }) => candidates.map(({ id }: { id: string }) => ({ id, accepted: true, kind: 'quality' as const, reason: 'new' })));
    const pipeline = new QualityPipeline({ fetchText } as never, gateway({ evaluateCandidates }));

    const result = await pipeline.run({ keyword: 'agents', candidates: [web, social], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' });

    expect(fetchText).toHaveBeenCalledOnce();
    expect(fetchText).toHaveBeenCalledWith(web.canonicalUrl, undefined);
    expect(evaluateCandidates).toHaveBeenCalledOnce();
    expect(evaluateCandidates.mock.calls[0]![0].candidates[0].text).toContain('complete article body');
    expect(result).toHaveLength(2);
  });

  it('rejects low-value, duplicate, and historical candidates before AI review', async () => {
    const accepted = candidate('1', { content: 'A substantive article with detailed architecture, benchmarks, migration steps, and limitations.' });
    const lowValue = candidate('search', { url: 'https://low.example/search?q=agents', content: 'thin' });
    const duplicate = validateSourceCandidate({ ...accepted, connectorId: 'rss', proof: {
      kind: 'feed_entry', connectorId: 'rss', feedUrl: 'https://example1.com/feed', entryId: 'duplicate',
    } });
    const historical = candidate('3', { content: 'A substantive historical article with detailed implementation information.' });
    const evaluateCandidates = vi.fn(async ({ candidates }) => candidates.map(({ id }: { id: string }) => ({ id, accepted: true, kind: 'quality' as const, reason: 'new' })));
    const pipeline = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({ evaluateCandidates }));

    await pipeline.run({ keyword: 'agents', candidates: [accepted, lowValue, duplicate, historical],
      historyUrls: [historical.canonicalUrl], windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' });

    expect(evaluateCandidates.mock.calls[0]![0].candidates).toHaveLength(1);
    expect(evaluateCandidates.mock.calls[0]![0].candidates[0].id).toBe(accepted.canonicalUrl);
  });

  it('allows empty success and rejects composed URLs outside the accepted pool', async () => {
    const source = candidate('1', { content: 'A substantive article with detailed architecture, benchmarks, migration steps, and limitations.' });
    const rejecting = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({
      evaluateCandidates: async () => [{ id: source.canonicalUrl, accepted: false, kind: null, reason: 'low value' }],
      composeItems: vi.fn(),
    }));
    await expect(rejecting.run({ keyword: 'agents', candidates: [source], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' })).resolves.toEqual([]);

    const inventing = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({
      composeItems: async () => [{ ...composed(source), sourceUrls: ['https://invented.example/article'] }],
    }));
    await expect(inventing.run({ keyword: 'agents', candidates: [source], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'QUALITY_RESPONSE_INVALID' });
  });

  it('rejects an incomplete AI assessment batch', async () => {
    const first = candidate('1', { content: 'A substantive article with detailed architecture, benchmarks, migration steps, and limitations.' });
    const second = candidate('2', { content: 'Another substantive article with implementation details, measurements, and tradeoffs.' });
    const pipeline = new QualityPipeline({ fetchText: vi.fn() } as never, gateway({
      evaluateCandidates: async () => [{ id: first.canonicalUrl, accepted: true, kind: 'quality', reason: 'new' }],
    }));

    await expect(pipeline.run({ keyword: 'agents', candidates: [first, second], historyUrls: [],
      windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-07-27T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'QUALITY_RESPONSE_INVALID' });
  });
});
