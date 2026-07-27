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

export type QualityAiGateway = Pick<AiGateway, 'evaluateCandidates' | 'composeItems'>;
export type { QualityAssessment, QualityAssessmentCandidate } from './ai-gateway.js';
export interface QualityPipelineInput {
  keyword: string; candidates: ValidatedSourceCandidate[]; historyUrls: string[];
  windowStart: string; windowEnd: string; signal?: AbortSignal;
}
interface ContentFetcherLike { fetchText(url: string, signal?: AbortSignal): Promise<FetchedText> }

export class QualityPipelineError extends Error {
  readonly code = 'QUALITY_RESPONSE_INVALID';
  constructor(message = 'AI quality response is invalid') { super(message); this.name = 'QualityPipelineError'; }
}

export class QualityPipeline {
  constructor(private readonly contentFetcher: ContentFetcherLike, private readonly gateway: QualityAiGateway) {}

  async run(input: QualityPipelineInput): Promise<DiscoveryCandidate[]> {
    const inWindow = input.candidates.filter((item) => !rejectCandidate(item, {
      windowStart: input.windowStart, windowEnd: input.windowEnd,
    }).rejected);
    const deduplicated = deduplicateCandidates(inWindow);
    const history = new Set(input.historyUrls.map((url) => canonicalizeUrl(url)));
    const unseen = deduplicated.filter((item) => !history.has(item.canonicalUrl));
    const enriched: ValidatedSourceCandidate[] = [];
    for (const item of unseen) {
      const needsBody = (item.sourceType === 'web' || item.sourceType === 'feed') && item.content === null;
      if (!needsBody) { enriched.push(item); continue; }
      try {
        const fetched = await this.contentFetcher.fetchText(item.canonicalUrl, input.signal);
        const normalized = validateSourceCandidate({
          ...item, title: item.title ?? fetched.title, content: fetched.text,
        });
        if (!rejectCandidate(normalized, { windowStart: input.windowStart, windowEnd: input.windowEnd }).rejected) enriched.push(normalized);
      } catch {
        // High precision mode drops candidates whose required body cannot be fetched safely.
      }
    }
    if (enriched.length === 0) return [];

    const assessmentCandidates = this.toAssessmentCandidates(enriched);
    const assessments = await this.gateway.evaluateCandidates({ keyword: input.keyword, candidates: assessmentCandidates });
    const decisions = this.validateAssessments(assessments, new Set(assessmentCandidates.map((item) => item.id)));
    const accepted = enriched.flatMap((candidate) => {
      const assessment = decisions.get(candidate.canonicalUrl);
      return assessment?.accepted ? [{ candidate, assessment }] : [];
    });
    if (accepted.length === 0) return [];

    const selectedCandidates = selectDiverseCandidates(accepted.map(({ candidate }) => candidate), 8);
    const acceptedById = new Map(accepted.map((item) => [item.candidate.canonicalUrl, item]));
    const selected = selectedCandidates.map((candidate) => acceptedById.get(candidate.canonicalUrl)!).filter(Boolean);
    const rawItems = await this.gateway.composeItems({ keyword: input.keyword, candidates: selected });
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

  private validateAssessments(values: QualityAssessment[], allowed: Set<string>): Map<string, QualityAssessment> {
    const decisions = new Map<string, QualityAssessment>();
    for (const value of values) {
      if (!allowed.has(value.id) || decisions.has(value.id) || typeof value.accepted !== 'boolean' || typeof value.reason !== 'string' || value.reason.trim().length === 0 || value.accepted && value.kind !== 'hot' && value.kind !== 'quality' || !value.accepted && value.kind !== null) throw new QualityPipelineError();
      decisions.set(value.id, value);
    }
    if (decisions.size !== allowed.size) throw new QualityPipelineError();
    return decisions;
  }
}
