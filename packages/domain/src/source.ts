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

export class SourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceValidationError';
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new SourceValidationError(`${label} must be a string`);
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireString(value, label);
}

const trimNullable = (value: string | null): string | null => value?.trim() || null;

function canonicalHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceValidationError(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SourceValidationError(`${label} must use HTTP or HTTPS`);
  }
  return canonicalizeUrl(value);
}

function normalizePublishedAt(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (match === null) {
    throw new SourceValidationError('Published time must be an ISO datetime or null');
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(normalized))
  ) {
    throw new SourceValidationError('Published time must be an ISO datetime or null');
  }
  return normalized;
}

function normalizeProof(proof: Record<string, unknown>): SourceProof {
  const connectorId = requireString(proof.connectorId, 'Proof connector ID').trim();
  switch (proof.kind) {
    case 'ai_citation':
      return {
        kind: proof.kind,
        connectorId,
        citationUrl: canonicalHttpUrl(
          requireString(proof.citationUrl, 'Citation URL').trim(),
          'Citation URL',
        ),
      };
    case 'api_record':
      return {
        kind: proof.kind,
        connectorId,
        externalId: requireString(proof.externalId, 'API proof external ID').trim(),
      };
    case 'feed_entry':
      return {
        kind: proof.kind,
        connectorId,
        feedUrl: canonicalHttpUrl(
          requireString(proof.feedUrl, 'Feed URL').trim(),
          'Feed URL',
        ),
        entryId: requireString(proof.entryId, 'Feed entry ID').trim(),
      };
    case 'fetched_page':
      return {
        kind: proof.kind,
        connectorId,
        parentUrl: canonicalHttpUrl(
          requireString(proof.parentUrl, 'Fetched-page parent URL').trim(),
          'Fetched-page parent URL',
        ),
      };
    default:
      throw new SourceValidationError('Proof kind is not supported');
  }
}

export function validateSourceCandidate(input: unknown): ValidatedSourceCandidate {
  if (!isPlainObject(input)) throw new SourceValidationError('Candidate must be a plain object');
  const sourceType = sourceTypeSchema.safeParse(input.sourceType);
  if (!sourceType.success) throw new SourceValidationError('Source type is not supported');
  if (!isPlainObject(input.engagement)) {
    throw new SourceValidationError('Engagement must be a plain object');
  }
  if (
    Object.values(input.engagement).some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new SourceValidationError('Engagement values must be finite nonnegative numbers');
  }
  if (!isPlainObject(input.proof)) {
    throw new SourceValidationError('Proof must be a plain object');
  }
  if (
    input.proof.kind !== 'ai_citation' &&
    input.proof.kind !== 'api_record' &&
    input.proof.kind !== 'feed_entry' &&
    input.proof.kind !== 'fetched_page'
  ) {
    throw new SourceValidationError('Proof kind is not supported');
  }
  const proof = normalizeProof(input.proof);
  const candidate: SourceCandidate = {
    connectorId: requireString(input.connectorId, 'Connector ID'),
    sourceType: sourceType.data,
    platform: requireString(input.platform, 'Platform'),
    externalId: requireNullableString(input.externalId, 'External ID'),
    url: requireString(input.url, 'Candidate URL'),
    title: requireNullableString(input.title, 'Title'),
    content: requireNullableString(input.content, 'Content'),
    excerpt: requireNullableString(input.excerpt, 'Excerpt'),
    authorName: requireNullableString(input.authorName, 'Author name'),
    authorHandle: requireNullableString(input.authorHandle, 'Author handle'),
    publishedAt: requireNullableString(input.publishedAt, 'Published time'),
    language: requireNullableString(input.language, 'Language'),
    engagement: input.engagement as Record<string, number>,
    proof,
  };
  const connectorId = candidate.connectorId.trim();
  if (connectorId.length === 0) {
    throw new SourceValidationError('Connector ID must not be empty');
  }
  const platform = candidate.platform.trim();
  if (platform.length === 0) throw new SourceValidationError('Platform must not be empty');
  const externalId = trimNullable(candidate.externalId);
  const canonicalUrl = canonicalHttpUrl(candidate.url.trim(), 'Candidate URL');
  if (proof.connectorId.trim() !== connectorId) {
    throw new SourceValidationError('Proof connector does not match candidate connector');
  }
  if (proof.kind === 'ai_citation' && proof.citationUrl !== canonicalUrl) {
    throw new SourceValidationError('Citation URL does not match candidate URL');
  }
  if (proof.kind === 'api_record' && proof.externalId !== externalId) {
    throw new SourceValidationError('API proof external ID does not match candidate external ID');
  }
  if (proof.kind === 'feed_entry' && proof.entryId.length === 0) {
    throw new SourceValidationError('Feed entry ID must not be empty');
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
    engagement: { ...candidate.engagement },
    proof,
  };
}
