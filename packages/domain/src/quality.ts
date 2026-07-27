import type { ValidatedSourceCandidate } from './source.js';

export type QualityRejectionReason =
  | 'NON_CONTENT_PAGE'
  | 'OUTSIDE_TIME_WINDOW'
  | 'INSUFFICIENT_CONTENT';

export interface QualityRejection {
  rejected: boolean;
  reason: QualityRejectionReason | null;
}

export interface RejectCandidateOptions {
  windowStart?: string | Date;
  windowEnd?: string | Date;
}

const nonContentPath = /^\/(?:search|tag|tags|category|categories|login|signin)(?:\/|$)/i;
const englishReleaseAction =
  /\b(?:release(?:d)?|launch(?:ed)?|announce(?:d)?|publish(?:ed)?|available|open[\s-]?source(?:d)?)\b/iu;
const chineseReleaseAction = /发布|上线|推出|更新|开源|宣布/u;
const numberedVersion =
  /\b(?:v|version)\s*\d+(?:\.\d+)*\b|\d+(?:\.\d+)*\s*版本/iu;

function hasValidConcreteDate(text: string): boolean {
  const matches = text.matchAll(/\b(\d{4})([-/.])(\d{1,2})\2(\d{1,2})\b/gu);
  for (const match of matches) {
    const year = Number(match[1]);
    const month = Number(match[3]);
    const day = Number(match[4]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month >= 1 && month <= 12 && day >= 1 && day <= (daysInMonth[month - 1] ?? 0)) {
      return true;
    }
  }
  return false;
}

function hasValidHttpLink(text: string): boolean {
  const candidates = text.match(/https?:\/\/[^\s]*/giu) ?? [];
  return candidates.some((candidate) => {
    const trimmed = candidate.replace(/[),.!?;，。！？；]+$/u, '');
    try {
      const url = new URL(trimmed);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
    } catch {
      return false;
    }
  });
}

function hasConcreteSocialSignal(text: string): boolean {
  if (numberedVersion.test(text) || hasValidConcreteDate(text) || hasValidHttpLink(text)) {
    return true;
  }
  if (!englishReleaseAction.test(text) && !chineseReleaseAction.test(text)) return false;

  const context = text
    .replace(
      /\b(?:release(?:d)?|launch(?:ed)?|announce(?:d)?|publish(?:ed)?|available|open[\s-]?source(?:d)?|today|now|soon|tbd)\b/giu,
      '',
    )
    .replace(/发布|上线|推出|更新|开源|宣布|今天|正式|即将/gu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
  return [...context].length >= 2;
}

function isFirstPartyShortPost(candidate: ValidatedSourceCandidate, text: string): boolean {
  return (
    candidate.sourceType === 'social' &&
    candidate.proof.kind === 'api_record' &&
    candidate.externalId !== null &&
    (candidate.authorHandle !== null || candidate.authorName !== null) &&
    hasConcreteSocialSignal(text)
  );
}

export function rejectCandidate(
  candidate: ValidatedSourceCandidate,
  options: RejectCandidateOptions = {},
): QualityRejection {
  if (nonContentPath.test(new URL(candidate.canonicalUrl).pathname)) {
    return { rejected: true, reason: 'NON_CONTENT_PAGE' };
  }
  if (candidate.publishedAt !== null) {
    const publishedAt = Date.parse(candidate.publishedAt);
    const windowStart =
      options.windowStart instanceof Date
        ? options.windowStart.getTime()
        : options.windowStart === undefined
          ? null
          : Date.parse(options.windowStart);
    const windowEnd =
      options.windowEnd instanceof Date
        ? options.windowEnd.getTime()
        : options.windowEnd === undefined
          ? null
          : Date.parse(options.windowEnd);
    if (
      (windowStart !== null && publishedAt < windowStart) ||
      (windowEnd !== null && publishedAt > windowEnd)
    ) {
      return { rejected: true, reason: 'OUTSIDE_TIME_WINDOW' };
    }
  }
  const substantiveText = [candidate.title, candidate.content, candidate.excerpt]
    .filter((value): value is string => value !== null)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (substantiveText.length < 40 && !isFirstPartyShortPost(candidate, substantiveText)) {
    return { rejected: true, reason: 'INSUFFICIENT_CONTENT' };
  }
  return { rejected: false, reason: null };
}

const normalizeFingerprintText = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');

function candidateFingerprint(candidate: ValidatedSourceCandidate): string | null {
  const title = normalizeFingerprintText(candidate.title ?? '');
  const body = normalizeFingerprintText(candidate.content ?? candidate.excerpt ?? '');
  if (title.length === 0 || body.length < 48) return null;
  return `${title}\u0000${body}`;
}

const contentLength = (value: ValidatedSourceCandidate): number =>
  [value.title, value.content, value.excerpt].reduce(
    (total, text) => total + (text?.length ?? 0),
    0,
  );

export function deduplicateCandidates(
  candidates: readonly ValidatedSourceCandidate[],
): ValidatedSourceCandidate[] {
  const parents = candidates.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root] ?? root;
    while (parents[index] !== index) {
      const next = parents[index] ?? root;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  const keyOwner = new Map<string, number>();
  const fingerprints = candidates.map(candidateFingerprint);
  const lengths = candidates.map(contentLength);
  candidates.forEach((candidate, index) => {
    const keys = [`url\u0000${candidate.canonicalUrl}`];
    if (candidate.externalId !== null) {
      keys.push(
        `external\u0000${candidate.connectorId}\u0000${candidate.platform.toLowerCase()}\u0000${candidate.externalId}`,
      );
    }
    const fingerprint = fingerprints[index];
    if (fingerprint !== null && fingerprint !== undefined) {
      keys.push(`fingerprint\u0000${fingerprint}`);
    }
    for (const key of keys) {
      const owner = keyOwner.get(key);
      if (owner === undefined) keyOwner.set(key, index);
      else union(index, owner);
    }
  });

  const groups = new Map<number, { firstIndex: number; bestIndex: number }>();
  candidates.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group === undefined) {
      groups.set(root, { firstIndex: index, bestIndex: index });
      return;
    }
    if ((lengths[index] ?? 0) > (lengths[group.bestIndex] ?? 0)) group.bestIndex = index;
  });

  return [...groups.values()]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map(({ bestIndex }) => candidates[bestIndex])
    .filter((candidate): candidate is ValidatedSourceCandidate => candidate !== undefined);
}

function diversityBucket(candidate: ValidatedSourceCandidate): string {
  if (candidate.sourceType === 'web' || candidate.sourceType === 'feed') {
    return new URL(candidate.canonicalUrl).hostname.toLowerCase();
  }
  return candidate.platform.toLowerCase();
}

export function selectDiverseCandidates(
  candidates: readonly ValidatedSourceCandidate[],
  limit: number,
): ValidatedSourceCandidate[] {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) return [];
  const bucketCount = new Set(candidates.map(diversityBucket)).size;
  if (normalizedLimit < 3 || bucketCount < 3) return candidates.slice(0, normalizedLimit);

  const perBucketLimit = Math.max(1, Math.floor(normalizedLimit * 0.4));
  const selectedIndices = new Set<number>();
  const selectedPerBucket = new Map<string, number>();
  for (const [index, candidate] of candidates.entries()) {
    if (selectedIndices.size === normalizedLimit) break;
    const bucket = diversityBucket(candidate);
    const count = selectedPerBucket.get(bucket) ?? 0;
    if (count >= perBucketLimit) continue;
    selectedIndices.add(index);
    selectedPerBucket.set(bucket, count + 1);
  }
  const minimumResultSize = Math.min(3, normalizedLimit);
  if (selectedIndices.size < minimumResultSize) {
    for (const [index] of candidates.entries()) {
      if (selectedIndices.size === minimumResultSize) break;
      selectedIndices.add(index);
    }
  }
  return [...selectedIndices]
    .sort((left, right) => left - right)
    .map((index) => candidates[index])
    .filter((candidate): candidate is ValidatedSourceCandidate => candidate !== undefined);
}
