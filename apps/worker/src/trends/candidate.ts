import type { TrendSeedCandidate } from './types.js';

export const MAX_TREND_TITLE_LENGTH = 500;
export const MAX_TREND_EXTERNAL_ID_LENGTH = 500;
export const MAX_TREND_URL_LENGTH = 2_048;

export function isoFromUnixSeconds(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const milliseconds = value * 1_000;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function createTrendCandidate(value: TrendSeedCandidate): TrendSeedCandidate | null {
  const sourceId = value.sourceId.trim();
  const platform = value.platform.trim();
  const externalId = value.externalId.trim();
  const title = value.title.trim();
  if (
    sourceId.length < 1 || sourceId.length > 100 ||
    platform.length < 1 || platform.length > 100 ||
    externalId.length < 1 || externalId.length > MAX_TREND_EXTERNAL_ID_LENGTH ||
    title.length < 1 || title.length > MAX_TREND_TITLE_LENGTH ||
    value.url.length > MAX_TREND_URL_LENGTH
  ) return null;
  let url: URL;
  try { url = new URL(value.url); } catch { return null; }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.toString().length > MAX_TREND_URL_LENGTH
  ) return null;
  if (value.publishedAt !== null) {
    const milliseconds = Date.parse(value.publishedAt);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.publishedAt) return null;
  }
  return { sourceId, platform, externalId, title, url: url.toString(), publishedAt: value.publishedAt };
}
