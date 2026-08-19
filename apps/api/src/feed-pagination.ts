import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface FeedCursorFilter {
  origin: 'all' | 'topic' | 'trend' | 'creator';
  topicId: string | null;
  kind: 'hot' | 'quality' | null;
  query: string | null;
  reading: 'saved' | 'archived' | null;
  windowKey: string | null;
  limit: number;
}

export interface FeedPaginationContext {
  snapshotAt: Date;
  since: Date | null;
  offset: number;
  limit: number;
  fingerprint: string;
}

const cursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  snapshotAt: z.iso.datetime(),
  since: z.iso.datetime().nullable(),
  offset: z.number().int().nonnegative().max(100_000),
  fingerprint: z.string().length(64),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
});

export class InvalidFeedCursorError extends Error {
  constructor() {
    super('Feed cursor is invalid');
    this.name = 'InvalidFeedCursorError';
  }
}

function fingerprint(userId: string, filter: FeedCursorFilter): string {
  return createHash('sha256').update(JSON.stringify({ userId, ...filter })).digest('hex');
}

function unsignedPayload(input: {
  version: 1;
  snapshotAt: string;
  since: string | null;
  offset: number;
  fingerprint: string;
}) {
  return {
    version: input.version,
    snapshotAt: input.snapshotAt,
    since: input.since,
    offset: input.offset,
    fingerprint: input.fingerprint,
  };
}

function sign(payload: ReturnType<typeof unsignedPayload>, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

function decodeCursor(cursor: string, secret: string) {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const payload = cursorPayloadSchema.parse(JSON.parse(json));
    const expected = Buffer.from(sign(unsignedPayload(payload), secret), 'hex');
    const actual = Buffer.from(payload.signature, 'hex');
    if (!timingSafeEqual(expected, actual)) throw new InvalidFeedCursorError();
    return payload;
  } catch {
    throw new InvalidFeedCursorError();
  }
}

export function resolveFeedPagination(input: {
  userId: string;
  filter: FeedCursorFilter;
  since: Date | null;
  now: Date;
  secret: string;
  cursor?: string;
}): FeedPaginationContext {
  const expectedFingerprint = fingerprint(input.userId, input.filter);
  if (!input.cursor) {
    return {
      snapshotAt: input.now,
      since: input.since,
      offset: 0,
      limit: input.filter.limit,
      fingerprint: expectedFingerprint,
    };
  }

  const payload = decodeCursor(input.cursor, input.secret);
  if (payload.fingerprint !== expectedFingerprint) throw new InvalidFeedCursorError();
  const snapshotAt = new Date(payload.snapshotAt);
  const since = payload.since === null ? null : new Date(payload.since);
  if (!Number.isFinite(snapshotAt.getTime()) || (since && !Number.isFinite(since.getTime()))) {
    throw new InvalidFeedCursorError();
  }
  return {
    snapshotAt,
    since,
    offset: payload.offset,
    limit: input.filter.limit,
    fingerprint: expectedFingerprint,
  };
}

export function createFeedCursor(
  context: FeedPaginationContext,
  nextOffset: number,
  secret: string,
): string {
  const payload = {
    version: 1,
    snapshotAt: context.snapshotAt.toISOString(),
    since: context.since?.toISOString() ?? null,
    offset: nextOffset,
    fingerprint: context.fingerprint,
  } as const;
  return Buffer.from(JSON.stringify({
    ...payload,
    signature: sign(payload, secret),
  })).toString('base64url');
}
