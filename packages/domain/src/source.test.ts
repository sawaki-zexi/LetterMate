import { describe, expect, it } from 'vitest';
import type { SourceCandidate } from './source.js';
import { validateSourceCandidate } from './source.js';

const makeCandidate = (overrides: Partial<SourceCandidate> = {}): SourceCandidate => ({
  connectorId: 'web-search',
  sourceType: 'web',
  platform: 'Example',
  externalId: null,
  url: 'https://example.com/article',
  title: 'Article title',
  content: 'Substantive article content',
  excerpt: null,
  authorName: null,
  authorHandle: null,
  publishedAt: null,
  language: null,
  engagement: {},
  proof: {
    kind: 'ai_citation',
    connectorId: 'web-search',
    citationUrl: 'https://example.com/article',
  },
  ...overrides,
});

describe('source candidate validation', () => {
  it('normalizes a valid Twitter API record candidate', () => {
    expect(
      validateSourceCandidate({
        connectorId: 'twitter-api',
        sourceType: 'social',
        platform: '  Twitter  ',
        externalId: ' 123 ',
        url: 'https://mobile.twitter.com/project/status/123/?utm_source=feed#replies',
        title: '  Project update  ',
        content: '  Version 2 is available.  ',
        excerpt: null,
        authorName: ' Project Team ',
        authorHandle: ' @project ',
        publishedAt: '2026-07-27T06:30:00.000Z',
        language: ' en ',
        engagement: { likes: 12, reposts: 3 },
        proof: {
          kind: 'api_record',
          connectorId: 'twitter-api',
          externalId: '123',
        },
      }),
    ).toMatchObject({
      connectorId: 'twitter-api',
      platform: 'Twitter',
      externalId: '123',
      canonicalUrl: 'https://x.com/project/status/123',
      title: 'Project update',
      content: 'Version 2 is available.',
      authorName: 'Project Team',
      authorHandle: '@project',
      language: 'en',
    });
  });

  it('rejects proof from a different connector', () => {
    expect(() =>
      validateSourceCandidate({
        connectorId: 'github-api',
        sourceType: 'code',
        platform: 'GitHub',
        externalId: 'release-1',
        url: 'https://github.com/acme/project/releases/tag/v1',
        title: 'Version 1',
        content: null,
        excerpt: 'First release',
        authorName: 'Acme',
        authorHandle: 'acme',
        publishedAt: null,
        language: 'en',
        engagement: {},
        proof: {
          kind: 'api_record',
          connectorId: 'other-api',
          externalId: 'release-1',
        },
      }),
    ).toThrow('Proof connector does not match candidate connector');
  });

  it('rejects an API proof with a different external ID', () => {
    expect(() =>
      validateSourceCandidate({
        connectorId: 'github-api',
        sourceType: 'code',
        platform: 'GitHub',
        externalId: 'release-1',
        url: 'https://github.com/acme/project/releases/tag/v1',
        title: 'Version 1',
        content: null,
        excerpt: 'First release',
        authorName: 'Acme',
        authorHandle: 'acme',
        publishedAt: null,
        language: 'en',
        engagement: {},
        proof: {
          kind: 'api_record',
          connectorId: 'github-api',
          externalId: 'release-2',
        },
      }),
    ).toThrow('API proof external ID does not match candidate external ID');
  });

  it('rejects candidate URLs with a non-HTTP protocol', () => {
    expect(() =>
      validateSourceCandidate({
        connectorId: 'feed',
        sourceType: 'feed',
        platform: 'Blog',
        externalId: null,
        url: 'file:///tmp/post.html',
        title: 'Post',
        content: 'Useful content',
        excerpt: null,
        authorName: null,
        authorHandle: null,
        publishedAt: null,
        language: null,
        engagement: {},
        proof: {
          kind: 'feed_entry',
          connectorId: 'feed',
          feedUrl: 'https://example.com/feed.xml',
          entryId: 'post-1',
        },
      }),
    ).toThrow('Candidate URL must use HTTP or HTTPS');
  });

  it('rejects a fetched page with an invalid parent URL', () => {
    expect(() =>
      validateSourceCandidate({
        connectorId: 'page-fetcher',
        sourceType: 'web',
        platform: 'Web',
        externalId: null,
        url: 'https://example.com/article',
        title: 'Article',
        content: 'Substantive article content',
        excerpt: null,
        authorName: null,
        authorHandle: null,
        publishedAt: null,
        language: null,
        engagement: {},
        proof: {
          kind: 'fetched_page',
          connectorId: 'page-fetcher',
          parentUrl: 'mailto:editor@example.com',
        },
      }),
    ).toThrow('Fetched-page parent URL must use HTTP or HTTPS');
  });

  it.each([
    ['negative', -1],
    ['infinite', Number.POSITIVE_INFINITY],
    ['not-a-number', Number.NaN],
  ])('rejects %s engagement values', (_label, value) => {
    expect(() => validateSourceCandidate(makeCandidate({ engagement: { likes: value } }))).toThrow(
      'Engagement values must be finite nonnegative numbers',
    );
  });

  it.each(['2026-07-27', 'July 27, 2026', 'not-a-date'])(
    'rejects a non-ISO published time: %s',
    (publishedAt) => {
      expect(() => validateSourceCandidate(makeCandidate({ publishedAt }))).toThrow(
        'Published time must be an ISO datetime or null',
      );
    },
  );

  it('accepts a citation URL canonically equivalent to the candidate URL', () => {
    const candidate = validateSourceCandidate(
      makeCandidate({
        url: 'https://twitter.com/project/status/123?utm_source=search',
        proof: {
          kind: 'ai_citation',
          connectorId: 'web-search',
          citationUrl: 'https://www.x.com/project/status/123#thread',
        },
      }),
    );

    expect(candidate.canonicalUrl).toBe('https://x.com/project/status/123');
    expect(candidate.proof).toEqual({
      kind: 'ai_citation',
      connectorId: 'web-search',
      citationUrl: 'https://x.com/project/status/123',
    });
  });

  it('rejects a citation URL for a different source', () => {
    expect(() =>
      validateSourceCandidate(
        makeCandidate({
          proof: {
            kind: 'ai_citation',
            connectorId: 'web-search',
            citationUrl: 'https://example.com/different-article',
          },
        }),
      ),
    ).toThrow('Citation URL does not match candidate URL');
  });

  it('normalizes a valid feed-entry proof', () => {
    const candidate = validateSourceCandidate(
      makeCandidate({
        connectorId: 'rss',
        sourceType: 'feed',
        proof: {
          kind: 'feed_entry',
          connectorId: ' rss ',
          feedUrl: 'https://example.com/feed.xml?utm_source=reader',
          entryId: ' article-1 ',
        },
      }),
    );

    expect(candidate.proof).toEqual({
      kind: 'feed_entry',
      connectorId: 'rss',
      feedUrl: 'https://example.com/feed.xml',
      entryId: 'article-1',
    });
  });

  it('rejects a feed-entry proof without an entry ID', () => {
    expect(() =>
      validateSourceCandidate(
        makeCandidate({
          connectorId: 'rss',
          sourceType: 'feed',
          proof: {
            kind: 'feed_entry',
            connectorId: 'rss',
            feedUrl: 'https://example.com/feed.xml',
            entryId: '   ',
          },
        }),
      ),
    ).toThrow('Feed entry ID must not be empty');
  });

  it('rejects an unsupported runtime source type', () => {
    expect(() =>
      validateSourceCandidate(
        makeCandidate({ sourceType: 'podcast' as SourceCandidate['sourceType'] }),
      ),
    ).toThrow('Source type is not supported');
  });

  it.each([
    [
      'connector ID',
      makeCandidate({
        connectorId: '   ',
        proof: {
          kind: 'ai_citation',
          connectorId: '   ',
          citationUrl: 'https://example.com/article',
        },
      }),
      'Connector ID must not be empty',
    ],
    ['platform', makeCandidate({ platform: '   ' }), 'Platform must not be empty'],
  ])('rejects a blank required %s', (_label, candidate, message) => {
    expect(() => validateSourceCandidate(candidate)).toThrow(message);
  });
});
