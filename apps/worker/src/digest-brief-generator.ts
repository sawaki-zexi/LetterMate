import type {
  AiGateway,
  DigestBriefCandidate,
  DigestBriefDraft,
} from './ai-gateway.js';
import { AiGatewayError } from './ai-gateway.js';
import { isChineseContent } from './chinese-content.js';
import type { DigestSnapshot } from './digest-service.js';

export const DIGEST_BRIEF_POLICY_VERSION = 'digest-brief-grounded-v1';
export const DIGEST_BRIEF_FALLBACK_VERSION = 'digest-brief-fallback-v1';

export interface DigestBriefGenerationResult {
  items: DigestSnapshot[];
  status: 'generated' | 'fallback';
  version: string;
  errorCode: string | null;
}

interface PreparedCandidate {
  candidate: DigestBriefCandidate;
  snapshot: DigestSnapshot;
  urlsBySourceId: Map<string, string>;
}

const fallback = (
  snapshots: readonly DigestSnapshot[],
  errorCode: string | null,
): DigestBriefGenerationResult => ({
  items: snapshots.map((snapshot) => ({
    ...snapshot,
    citationUrls: [...snapshot.citationUrls],
  })),
  status: 'fallback',
  version: DIGEST_BRIEF_FALLBACK_VERSION,
  errorCode,
});

const safeErrorCode = (error: unknown): string => (
  error instanceof AiGatewayError ? error.code : 'AI_DIGEST_GENERATION_FAILED'
);

const validDraftText = (value: string, maxLength: number): boolean => (
  value.trim().length > 0
  && value.length <= maxLength
  && isChineseContent(value)
  && !/(?:https?:\/\/|www\.)/iu.test(value)
);

const validDraft = (draft: DigestBriefDraft): boolean => (
  validDraftText(draft.conclusion, 1_000)
  && validDraftText(draft.evidence, 1_000)
  && validDraftText(draft.uncertainty, 500)
  && validDraftText(draft.followUp, 500)
  && draft.citationIds.length > 0
  && draft.citationIds.length <= 20
  && new Set(draft.citationIds).size === draft.citationIds.length
);

const prepareCandidates = (snapshots: readonly DigestSnapshot[]): PreparedCandidate[] => (
  snapshots.map((snapshot, itemIndex) => {
    const itemId = `item-${itemIndex + 1}`;
    const urlsBySourceId = new Map<string, string>();
    const sources = snapshot.citationUrls.map((url, sourceIndex) => {
      const id = `${itemId}-source-${sourceIndex + 1}`;
      urlsBySourceId.set(id, url);
      return {
        id,
        platform: snapshot.platform,
        publishedAt: snapshot.publishedAt?.toISOString() ?? null,
      };
    });
    return {
      snapshot,
      urlsBySourceId,
      candidate: {
        id: itemId,
        title: snapshot.title,
        summary: snapshot.summary,
        reason: snapshot.reason,
        platform: snapshot.platform,
        publishedAt: snapshot.publishedAt?.toISOString() ?? null,
        sources,
      },
    };
  })
);

const applyDraft = (
  prepared: PreparedCandidate,
  draft: DigestBriefDraft,
): DigestSnapshot | null => {
  const citationUrls = draft.citationIds.map((id) => prepared.urlsBySourceId.get(id));
  if (citationUrls.some((url) => url === undefined)) return null;
  const uniqueUrls = [...new Set(citationUrls as string[])];
  if (uniqueUrls.length === 0) return null;
  return {
    ...prepared.snapshot,
    summary: draft.conclusion,
    sourceUrl: uniqueUrls[0]!,
    citationUrls: uniqueUrls,
    evidence: draft.evidence,
    uncertainty: draft.uncertainty,
    followUp: draft.followUp,
  };
};

export class DigestBriefGenerator {
  constructor(private readonly gateway?: Pick<AiGateway, 'composeDigestBriefs'>) {}

  async generate(input: {
    runId: string;
    userId: string;
    snapshots: readonly DigestSnapshot[];
    signal?: AbortSignal;
  }): Promise<DigestBriefGenerationResult> {
    if (input.snapshots.length === 0) return fallback([], null);
    if (!this.gateway) return fallback(input.snapshots, 'AI_NOT_CONFIGURED');
    const prepared = prepareCandidates(input.snapshots);
    try {
      const drafts = await this.gateway.composeDigestBriefs({
        candidates: prepared.map(({ candidate }) => candidate),
        execution: { runId: input.runId, userId: input.userId, runKind: 'digest' },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const expectedIds = new Set(prepared.map(({ candidate }) => candidate.id));
      const returnedIds = new Set(drafts.map(({ id }) => id));
      if (
        drafts.length !== prepared.length
        || returnedIds.size !== drafts.length
        || [...returnedIds].some((id) => !expectedIds.has(id))
        || drafts.some((draft) => !validDraft(draft))
      ) {
        return fallback(input.snapshots, 'AI_RESPONSE_INVALID');
      }
      const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));
      const generated = prepared.map((candidate) => {
        const draft = draftsById.get(candidate.candidate.id);
        return draft ? applyDraft(candidate, draft) : null;
      });
      if (generated.some((item) => item === null)) {
        return fallback(input.snapshots, 'AI_RESPONSE_INVALID');
      }
      return {
        items: generated as DigestSnapshot[],
        status: 'generated',
        version: DIGEST_BRIEF_POLICY_VERSION,
        errorCode: null,
      };
    } catch (error) {
      return fallback(input.snapshots, safeErrorCode(error));
    }
  }
}
