import { describe, expect, it } from 'vitest';
import {
  InvalidFeedCursorError,
  createFeedCursor,
  resolveFeedPagination,
} from './feed-pagination.js';

const filter = {
  origin: 'all' as const,
  topicId: null,
  kind: null,
  query: null,
  reading: null,
  windowKey: '30d',
  limit: 20,
};
const secret = 'feed-pagination-test-secret-at-least-32-bytes';

describe('Feed pagination cursor', () => {
  it('keeps the original snapshot and time boundary across pages', () => {
    const first = resolveFeedPagination({
      userId: 'user-1',
      filter,
      since: new Date('2026-07-17T08:00:00.000Z'),
      now: new Date('2026-08-16T08:00:00.000Z'),
      secret,
    });
    const cursor = createFeedCursor(first, 20, secret);
    const second = resolveFeedPagination({
      userId: 'user-1',
      filter,
      since: new Date('2026-07-18T08:00:00.000Z'),
      now: new Date('2026-08-17T08:00:00.000Z'),
      secret,
      cursor,
    });

    expect(second).toMatchObject({
      snapshotAt: new Date('2026-08-16T08:00:00.000Z'),
      since: new Date('2026-07-17T08:00:00.000Z'),
      offset: 20,
      limit: 20,
    });
  });

  it('rejects malformed, cross-user, and cross-filter cursors', () => {
    const first = resolveFeedPagination({
      userId: 'user-1', filter, since: null,
      now: new Date('2026-08-16T08:00:00.000Z'),
      secret,
    });
    const cursor = createFeedCursor(first, 20, secret);

    expect(() => resolveFeedPagination({
      userId: 'user-2', filter, since: null,
      now: new Date('2026-08-16T08:00:00.000Z'), secret, cursor,
    })).toThrow(InvalidFeedCursorError);
    expect(() => resolveFeedPagination({
      userId: 'user-1', filter: { ...filter, origin: 'trend' }, since: null,
      now: new Date('2026-08-16T08:00:00.000Z'), secret, cursor,
    })).toThrow(InvalidFeedCursorError);
    expect(() => resolveFeedPagination({
      userId: 'user-1', filter: { ...filter, reading: 'saved' }, since: null,
      now: new Date('2026-08-16T08:00:00.000Z'), secret, cursor,
    })).toThrow(InvalidFeedCursorError);
    expect(() => resolveFeedPagination({
      userId: 'user-1', filter, since: null,
      now: new Date('2026-08-16T08:00:00.000Z'), secret, cursor: 'broken',
    })).toThrow(InvalidFeedCursorError);

    const tamperedPayload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    tamperedPayload.offset = 40;
    const tampered = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
    expect(() => resolveFeedPagination({
      userId: 'user-1', filter, since: null,
      now: new Date('2026-08-16T08:00:00.000Z'), secret, cursor: tampered,
    })).toThrow(InvalidFeedCursorError);
  });
});
