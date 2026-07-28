import { discoveryCandidateSchema, type DiscoveryCandidate } from '@lettermate/contracts';
import {
  canonicalizeUrl, deduplicateCandidates, rejectCandidate, selectDiverseCandidates,
  validateSourceCandidate, type ValidatedSourceCandidate,
} from '@lettermate/domain';
import type { FetchedText } from './content-fetcher.js';
import type {
  AiGateway,
  QualityAssessment,
  QualityAssessmentCandidate,
} from './ai-gateway.js';
import {
  candidateMatchesKeyword,
  type KeywordPolicy,
} from './keyword-policy.js';

export type QualityAiGateway = Pick<AiGateway, 'evaluateCandidates' | 'composeItems'>;
export type { QualityAssessment, QualityAssessmentCandidate } from './ai-gateway.js';
export interface QualityPipelineInput {
  keyword: string; candidates: ValidatedSourceCandidate[]; historyUrls: string[];
  windowStart: string; windowEnd: string; matchPolicy: KeywordPolicy; signal?: AbortSignal;
}
interface ContentFetcherLike { fetchText(url: string, signal?: AbortSignal): Promise<FetchedText> }

const preferPolicyMatchingUrlDuplicates = (
  candidates: readonly ValidatedSourceCandidate[],
  matchPolicy: KeywordPolicy,
): ValidatedSourceCandidate[] => {
  const selectedByUrl = new Map<string, ValidatedSourceCandidate>();
  for (const candidate of candidates) {
    const existing = selectedByUrl.get(candidate.canonicalUrl);
    if (existing === undefined) {
      selectedByUrl.set(candidate.canonicalUrl, candidate);
      continue;
    }
    const existingMatches = candidateMatchesKeyword(existing, matchPolicy);
    const candidateMatches = candidateMatchesKeyword(candidate, matchPolicy);
    if (existingMatches !== candidateMatches) {
      selectedByUrl.set(candidate.canonicalUrl, candidateMatches ? candidate : existing);
      continue;
    }
    const richer = deduplicateCandidates(
      [existing, candidate],
      { includeFingerprint: false },
    )[0];
    if (richer !== undefined) selectedByUrl.set(candidate.canonicalUrl, richer);
  }
  return [...selectedByUrl.values()];
};

export class QualityPipelineError extends Error {
  readonly code = 'QUALITY_RESPONSE_INVALID';
  constructor(message = 'AI quality response is invalid') { super(message); this.name = 'QualityPipelineError'; }
}

export class QualityPipeline {
  constructor(private readonly contentFetcher: ContentFetcherLike, private readonly gateway: QualityAiGateway) {}

  async run(input: QualityPipelineInput): Promise<DiscoveryCandidate[]> {
    const preliminarilyEligible = input.candidates.filter((item) => {
      const rejection = rejectCandidate(item, {
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      });
      return !rejection.rejected || rejection.reason === 'INSUFFICIENT_CONTENT';
    });
    const preferredUrlDuplicates = preferPolicyMatchingUrlDuplicates(
      preliminarilyEligible,
      input.matchPolicy,
    );
    const deduplicated = deduplicateCandidates(
      preferredUrlDuplicates,
      { includeFingerprint: false },
    );
    const history = new Set(input.historyUrls.map((url) => canonicalizeUrl(url)));
    const unseen = deduplicated.filter((item) => !history.has(item.canonicalUrl));
    const enriched: ValidatedSourceCandidate[] = [];
    for (const item of unseen) {
      const needsBody = (
        item.sourceType === 'web' || item.sourceType === 'feed'
      ) && (item.content === null || item.content.trim().length < 40);
      if (!needsBody) { enriched.push(item); continue; }
      try {
        const fetched = await this.contentFetcher.fetchText(item.canonicalUrl, input.signal);
        const normalized = validateSourceCandidate({
          ...item, title: item.title ?? fetched.title, content: fetched.text,
        });
        enriched.push(normalized);
      } catch {
        // High precision mode drops candidates whose required body cannot be fetched safely.
      }
    }
    const policyMatched = enriched.filter(
      (item) => candidateMatchesKeyword(item, input.matchPolicy),
    );
    const qualified = policyMatched.filter((item) => !rejectCandidate(item, {
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    }).rejected);
    const finalCandidates = deduplicateCandidates(qualified);
    if (finalCandidates.length === 0) return [];

    const decisions = new Map<string, QualityAssessment>();
    for (let offset = 0; offset < finalCandidates.length; offset += 30) {
      if (input.signal?.aborted) throw new Error('Quality pipeline was aborted');
      const assessmentCandidates = this.toAssessmentCandidates(
        finalCandidates.slice(offset, offset + 30),
      );
      const assessments = await this.gateway.evaluateCandidates({
        keyword: input.keyword,
        candidates: assessmentCandidates,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const batch = this.validateAssessments(
        assessments,
        new Set(assessmentCandidates.map((item) => item.id)),
      );
      for (const [id, assessment] of batch) decisions.set(id, assessment);
    }
    const accepted = finalCandidates.flatMap((candidate) => {
      const assessment = decisions.get(candidate.canonicalUrl);
      return assessment?.accepted && assessment.claimSupport === 'supported'
        ? [{ candidate, assessment }]
        : [];
    });
    if (accepted.length === 0) return [];

    const selectedCandidates = selectDiverseCandidates(accepted.map(({ candidate }) => candidate), 8);
    const acceptedById = new Map(accepted.map((item) => [item.candidate.canonicalUrl, item]));
    const selected = selectedCandidates.map((candidate) => acceptedById.get(candidate.canonicalUrl)!).filter(Boolean);
    const compositionCandidates = this.toCompositionCandidates(selected);
    const rawItems = await this.gateway.composeItems({
      keyword: input.keyword,
      candidates: compositionCandidates,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!Array.isArray(rawItems) || rawItems.length > 8) throw new QualityPipelineError();
    const allowed = new Map(selected.map(({ candidate }) => [candidate.canonicalUrl, candidate]));
    return rawItems.map((raw) => {
      const parsed = discoveryCandidateSchema.safeParse(raw);
      if (!parsed.success) throw new QualityPipelineError();
      let urls: string[];
      try { urls = [...new Set(parsed.data.sourceUrls.map(canonicalizeUrl))]; } catch { throw new QualityPipelineError(); }
      if (urls.length === 0 || urls.some((url) => !allowed.has(url))) throw new QualityPipelineError();
      const source = allowed.get(urls[0]!);
      if (source === undefined) throw new QualityPipelineError();
      return discoveryCandidateSchema.parse({
        ...parsed.data, sourceUrls: urls, sourceType: source.sourceType, platform: source.platform,
        authorName: source.authorName, authorHandle: source.authorHandle, externalId: source.externalId,
        provenanceKind: source.proof.kind, publishedAt: source.publishedAt,
      });
    });
  }

  private toAssessmentCandidates(candidates: ValidatedSourceCandidate[]): QualityAssessmentCandidate[] {
    let remaining = 60_000;
    return candidates.map((candidate) => {
      const fullText = [candidate.title, candidate.content, candidate.excerpt].filter(Boolean).join('\n\n');
      const text = fullText.slice(0, Math.max(0, Math.min(12_000, remaining))); remaining -= text.length;
      return {
        id: candidate.canonicalUrl, url: candidate.canonicalUrl, sourceType: candidate.sourceType,
        platform: candidate.platform, title: candidate.title, text, authorName: candidate.authorName,
        authorHandle: candidate.authorHandle, publishedAt: candidate.publishedAt,
      };
    });
  }

  private toCompositionCandidates(
    selected: Array<{ candidate: ValidatedSourceCandidate; assessment: QualityAssessment }>,
  ): Array<{ candidate: ValidatedSourceCandidate; assessment: QualityAssessment }> {
    let totalRemaining = 60_000;
    return selected.map(({ candidate, assessment }, index) => {
      const remainingItems = selected.length - index;
      let itemRemaining = Math.min(
        12_000,
        Math.floor(totalRemaining / remainingItems),
      );
      const take = (value: string | null): string | null => {
        if (value === null) return null;
        const result = value.slice(0, itemRemaining);
        itemRemaining -= result.length;
        totalRemaining -= result.length;
        return result;
      };
      const title = take(candidate.title);
      const content = take(candidate.content);
      const excerpt = take(candidate.excerpt);
      return {
        candidate: { ...candidate, title, content, excerpt },
        assessment,
      };
    });
  }

  private validateAssessments(values: QualityAssessment[], allowed: Set<string>): Map<string, QualityAssessment> {
    const decisions = new Map<string, QualityAssessment>();
    for (const value of values) {
      if (!allowed.has(value.id) || decisions.has(value.id) || typeof value.accepted !== 'boolean' || typeof value.reason !== 'string' || value.reason.trim().length === 0 || value.accepted && value.kind !== 'hot' && value.kind !== 'quality' || !value.accepted && value.kind !== null || value.claimSupport !== 'supported' && value.claimSupport !== 'unsupported' && value.claimSupport !== 'conflicting') throw new QualityPipelineError();
      decisions.set(value.id, value);
    }
    if (decisions.size !== allowed.size) throw new QualityPipelineError();
    return decisions;
  }
}
