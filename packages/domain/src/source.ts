import { sourceTypeSchema, type SourceType } from '@lettermate/contracts';
import { canonicalizeUrl } from './url.js';

export type SourceProof =
  | { kind: 'ai_citation'; connectorId: string; citationUrl: string }
  | { kind: 'api_record'; connectorId: string; externalId: string }
  | { kind: 'feed_entry'; connectorId: string; feedUrl: string; entryId: string }
  | { kind: 'fetched_page'; connectorId: string; parentUrl: string };

export interface SourceCandidate {
  connectorId: string;
  sourceType: SourceType;
  platform: string;
  externalId: string | null;
  url: string;
  title: string | null;
  content: string | null;
  excerpt: string | null;
  authorName: string | null;
  authorHandle: string | null;
  publishedAt: string | null;
  language: string | null;
  engagement: Record<string, number>;
  proof: SourceProof;
}

export interface ValidatedSourceCandidate extends SourceCandidate {
  canonicalUrl: string;
}

const trimNullable = (value: string | null): string | null => value?.trim() || null;

function canonicalHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return canonicalizeUrl(value);
}

function normalizePublishedAt(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  const isoDateTime =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!isoDateTime.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new Error('Published time must be an ISO datetime or null');
  }
  return normalized;
}

function normalizeProof(proof: SourceProof): SourceProof {
  switch (proof.kind) {
    case 'ai_citation':
      return {
        ...proof,
        connectorId: proof.connectorId.trim(),
        citationUrl: canonicalHttpUrl(proof.citationUrl.trim(), 'Citation URL'),
      };
    case 'api_record':
      return {
        ...proof,
        connectorId: proof.connectorId.trim(),
        externalId: proof.externalId.trim(),
      };
    case 'feed_entry':
      return {
        ...proof,
        connectorId: proof.connectorId.trim(),
        feedUrl: canonicalHttpUrl(proof.feedUrl.trim(), 'Feed URL'),
        entryId: proof.entryId.trim(),
      };
    case 'fetched_page':
      return {
        ...proof,
        connectorId: proof.connectorId.trim(),
        parentUrl: canonicalHttpUrl(proof.parentUrl.trim(), 'Fetched-page parent URL'),
      };
  }
}

export function validateSourceCandidate(candidate: SourceCandidate): ValidatedSourceCandidate {
  const sourceType = sourceTypeSchema.safeParse(candidate.sourceType);
  if (!sourceType.success) throw new Error('Source type is not supported');
  const connectorId = candidate.connectorId.trim();
  if (connectorId.length === 0) throw new Error('Connector ID must not be empty');
  const platform = candidate.platform.trim();
  if (platform.length === 0) throw new Error('Platform must not be empty');
  const externalId = trimNullable(candidate.externalId);
  const canonicalUrl = canonicalHttpUrl(candidate.url.trim(), 'Candidate URL');
  if (
    Object.values(candidate.engagement).some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new Error('Engagement values must be finite nonnegative numbers');
  }
  const proof = normalizeProof(candidate.proof);

  if (proof.connectorId.trim() !== connectorId) {
    throw new Error('Proof connector does not match candidate connector');
  }
  if (proof.kind === 'ai_citation' && proof.citationUrl !== canonicalUrl) {
    throw new Error('Citation URL does not match candidate URL');
  }
  if (proof.kind === 'api_record' && proof.externalId !== externalId) {
    throw new Error('API proof external ID does not match candidate external ID');
  }
  if (proof.kind === 'feed_entry' && proof.entryId.length === 0) {
    throw new Error('Feed entry ID must not be empty');
  }

  return {
    ...candidate,
    connectorId,
    sourceType: sourceType.data,
    platform,
    externalId,
    url: candidate.url.trim(),
    canonicalUrl,
    title: trimNullable(candidate.title),
    content: trimNullable(candidate.content),
    excerpt: trimNullable(candidate.excerpt),
    authorName: trimNullable(candidate.authorName),
    authorHandle: trimNullable(candidate.authorHandle),
    publishedAt: normalizePublishedAt(candidate.publishedAt),
    language: trimNullable(candidate.language),
    proof,
  };
}
