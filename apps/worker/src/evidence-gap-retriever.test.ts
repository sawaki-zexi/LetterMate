import { describe, expect, it, vi } from 'vitest';
import { validateSourceCandidate } from '@lettermate/domain';
import { buildRequiredKeywordPolicy } from './keyword-policy.js';
import {
  EVIDENCE_FOLLOWUP_MAX_CANDIDATES,
  EvidenceGapRetriever,
} from './evidence-gap-retriever.js';
import { MemoryRunStageStore, RunStageManager } from './run-stage.js';

const execution = { runId: 'run-1', userId: 'user-1', runKind: 'topic' as const };

const candidate = (url: string, connectorId = 'search-brave') => validateSourceCandidate({
  connectorId,
  sourceType: 'web',
  platform: 'Example',
  externalId: null,
  url,
  title: 'React 19.1 server rendering release',
  content: 'React 19.1 release notes describe server rendering changes.',
  excerpt: null,
  authorName: null,
  authorHandle: null,
  publishedAt: '2026-08-08T10:00:00.000Z',
  language: 'en',
  engagement: {},
  proof: { kind: 'fetched_page', connectorId, parentUrl: url },
});

const plan = {
  keyword: 'React 19.1',
  matchPolicy: buildRequiredKeywordPolicy(['React', '19.1'], 'React 19.1'),
  expandedTerms: ['server rendering'],
  queries: ['React 19.1 release server rendering'],
  sourceTypes: ['web' as const, 'code' as const],
  connectorIds: ['search-brave', 'github'],
  windowStart: '2026-08-02T00:00:00.000Z',
  windowEnd: '2026-08-09T00:00:00.000Z',
  maxCandidates: 60,
};

const initial = {
  candidates: [candidate('https://example.com/react')],
  successfulConnectorIds: ['search-brave'],
  skippedConnectorIds: ['github'],
  failures: [],
};

const decision = {
  gap: 'missing_primary_record' as const,
  query: 'React 19.1 official release notes',
  requiredTerms: ['React', '19.1'],
  connectorIds: ['github'],
};

describe('EvidenceGapRetriever', () => {
  it('performs one bounded follow-up and merges candidates by canonical URL', async () => {
    const planEvidenceFollowup = vi.fn().mockResolvedValue(decision);
    const search = vi.fn().mockResolvedValue({
      candidates: [
        candidate('https://example.com/react#duplicate', 'github'),
        candidate('https://github.com/facebook/react/releases/tag/v19.1.0', 'github'),
      ],
      successfulConnectorIds: ['github'], skippedConnectorIds: ['search-brave'], failures: [],
    });

    const result = await new EvidenceGapRetriever(
      { planEvidenceFollowup }, { search },
    ).retrieve({ execution, plan, initial });

    expect(planEvidenceFollowup).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'React 19.1',
      matchPolicy: plan.matchPolicy,
      queries: ['React 19.1 official release notes'],
      connectorIds: ['github'],
      maxCandidates: EVIDENCE_FOLLOWUP_MAX_CANDIDATES,
    }), undefined);
    expect(result.candidates.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      'https://example.com/react',
      'https://github.com/facebook/react/releases/tag/v19.1.0',
    ]);
    expect(result.successfulConnectorIds).toEqual(['search-brave', 'github']);
    expect(result.skippedConnectorIds).toEqual([]);
  });

  it.each([
    { ...decision, query: 'React official release notes' },
    { ...decision, query: 'React 19.1 release notes', requiredTerms: ['React', '19.1', 'TypeScript'] },
    { ...decision, connectorIds: ['reddit'] },
    { ...decision, query: 'https://example.com React 19.1', requiredTerms: ['React', '19.1'] },
  ])('rejects an out-of-policy follow-up decision %#', async (invalidDecision) => {
    const search = vi.fn();
    const retriever = new EvidenceGapRetriever(
      { planEvidenceFollowup: vi.fn().mockResolvedValue(invalidDecision) }, { search },
    );

    await expect(retriever.retrieve({ execution, plan, initial })).resolves.toBe(initial);
    expect(search).not.toHaveBeenCalled();
  });

  it('keeps first-round evidence when planning or follow-up retrieval fails', async () => {
    const planningFailure = new EvidenceGapRetriever(
      { planEvidenceFollowup: vi.fn().mockRejectedValue(new Error('AI unavailable')) },
      { search: vi.fn() },
    );
    await expect(planningFailure.retrieve({ execution, plan, initial })).resolves.toBe(initial);

    const searchFailure = new EvidenceGapRetriever(
      { planEvidenceFollowup: vi.fn().mockResolvedValue(decision) },
      { search: vi.fn().mockRejectedValue(new Error('connector unavailable')) },
    );
    await expect(searchFailure.retrieve({ execution, plan, initial })).resolves.toBe(initial);
  });

  it('reuses the checkpointed merged result without another AI or connector call', async () => {
    const planEvidenceFollowup = vi.fn().mockResolvedValue(decision);
    const search = vi.fn().mockResolvedValue({
      candidates: [candidate('https://github.com/facebook/react/releases/tag/v19.1.0', 'github')],
      successfulConnectorIds: ['github'], skippedConnectorIds: [], failures: [],
    });
    const retriever = new EvidenceGapRetriever(
      { planEvidenceFollowup }, { search }, new RunStageManager(new MemoryRunStageStore()),
    );

    const first = await retriever.retrieve({ execution, plan, initial });
    const second = await retriever.retrieve({ execution, plan, initial });

    expect(second).toEqual(first);
    expect(planEvidenceFollowup).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledOnce();
  });
});
