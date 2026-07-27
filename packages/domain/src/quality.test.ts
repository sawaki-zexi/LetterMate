import { describe, expect, it } from 'vitest';
import {
  deduplicateCandidates,
  rejectCandidate,
  selectDiverseCandidates,
} from './quality.js';
import type { SourceCandidate } from './source.js';
import { validateSourceCandidate } from './source.js';

const makeCandidate = (overrides: Partial<SourceCandidate> = {}) =>
  validateSourceCandidate({
    connectorId: 'web-search',
    sourceType: 'web',
    platform: 'Example',
    externalId: null,
    url: 'https://example.com/articles/project-update',
    title: 'Project update',
    content: 'A detailed explanation of the project update and its practical impact.',
    excerpt: null,
    authorName: 'Example Editor',
    authorHandle: null,
    publishedAt: '2026-07-27T06:30:00.000Z',
    language: 'en',
    engagement: {},
    proof: {
      kind: 'ai_citation',
      connectorId: 'web-search',
      citationUrl: 'https://example.com/articles/project-update',
    },
    ...overrides,
  });

describe('deterministic candidate rejection', () => {
  it.each(['/search', '/tag/ai', '/categories/news', '/login', '/signin'])(
    'rejects a known non-content path: %s',
    (path) => {
      const url = `https://example.com${path}`;
      const candidate = makeCandidate({
        url,
        proof: { kind: 'ai_citation', connectorId: 'web-search', citationUrl: url },
      });

      expect(rejectCandidate(candidate)).toEqual({
        rejected: true,
        reason: 'NON_CONTENT_PAGE',
      });
    },
  );

  it.each([
    { title: null, content: null, excerpt: null },
    { title: 'AI', content: 'Soon.', excerpt: null },
  ])('rejects a candidate without substantive content', (fields) => {
    expect(rejectCandidate(makeCandidate(fields))).toEqual({
      rejected: true,
      reason: 'INSUFFICIENT_CONTENT',
    });
  });

  it.each(['Version 2 released today.', '项目今天正式发布。'])(
    'keeps a short first-party social announcement: %s',
    (content) => {
      const candidate = makeCandidate({
        connectorId: 'social-api',
        sourceType: 'social',
        platform: 'Social',
        externalId: 'post-42',
        title: null,
        content,
        excerpt: null,
        authorName: 'Project Team',
        authorHandle: '@project',
        proof: {
          kind: 'api_record',
          connectorId: 'social-api',
          externalId: 'post-42',
        },
      });

      expect(rejectCandidate(candidate)).toEqual({ rejected: false, reason: null });
    },
  );

  it.each(['2026-07-19T23:59:59.000Z', '2026-07-28T00:00:00.001Z'])(
    'rejects a candidate outside the requested time window: %s',
    (publishedAt) => {
      expect(
        rejectCandidate(makeCandidate({ publishedAt }), {
          windowStart: '2026-07-20T00:00:00.000Z',
          windowEnd: new Date('2026-07-28T00:00:00.000Z'),
        }),
      ).toEqual({ rejected: true, reason: 'OUTSIDE_TIME_WINDOW' });
    },
  );
});

describe('candidate deduplication', () => {
  it('merges twitter.com and x.com forms of the same post URL', () => {
    const twitter = makeCandidate({
      url: 'https://twitter.com/project/status/123?utm_source=feed',
      proof: {
        kind: 'ai_citation',
        connectorId: 'web-search',
        citationUrl: 'https://twitter.com/project/status/123',
      },
    });
    const x = makeCandidate({
      url: 'https://x.com/project/status/123#replies',
      proof: {
        kind: 'ai_citation',
        connectorId: 'web-search',
        citationUrl: 'https://x.com/project/status/123',
      },
    });

    expect(deduplicateCandidates([twitter, x])).toHaveLength(1);
  });

  it('merges matching stable external IDs from the same connector and platform', () => {
    const base = {
      connectorId: 'social-api',
      sourceType: 'social' as const,
      platform: 'Social',
      externalId: 'post-123',
      proof: {
        kind: 'api_record' as const,
        connectorId: 'social-api',
        externalId: 'post-123',
      },
    };
    const first = makeCandidate({ ...base, url: 'https://social.example/posts/123' });
    const alternate = makeCandidate({ ...base, url: 'https://social.example/@project/123' });

    expect(deduplicateCandidates([first, alternate])).toHaveLength(1);
  });

  it('prefers the duplicate with more substantive content and keeps its proof', () => {
    const url = 'https://example.com/articles/shared';
    const brief = makeCandidate({
      url,
      content: 'Brief update.',
      proof: { kind: 'ai_citation', connectorId: 'web-search', citationUrl: url },
    });
    const detailed = makeCandidate({
      connectorId: 'rss',
      sourceType: 'feed',
      url,
      content:
        'The release adds offline support, improves synchronization, and includes a migration guide.',
      proof: {
        kind: 'feed_entry',
        connectorId: 'rss',
        feedUrl: 'https://example.com/feed.xml',
        entryId: 'shared',
      },
    });

    expect(deduplicateCandidates([brief, detailed])).toEqual([detailed]);
  });

  it('merges obviously identical cross-channel copies by normalized fingerprint', () => {
    const article = makeCandidate({
      title: 'Project Aurora: Version 2 Released!',
      content:
        'Version 2 adds offline support, faster synchronization, and a complete migration guide for existing teams.',
    });
    const feedCopy = makeCandidate({
      connectorId: 'rss',
      sourceType: 'feed',
      platform: 'Project Blog',
      url: 'https://blog.example.net/aurora-v2',
      title: ' project aurora version 2 released ',
      content:
        'VERSION 2 adds offline support faster synchronization and a complete migration guide for existing teams',
      proof: {
        kind: 'feed_entry',
        connectorId: 'rss',
        feedUrl: 'https://blog.example.net/feed.xml',
        entryId: 'aurora-v2',
      },
    });

    expect(deduplicateCandidates([article, feedCopy])).toHaveLength(1);
  });

  it('does not collapse unrelated short posts with similar titles', () => {
    const first = makeCandidate({
      url: 'https://example.com/posts/one',
      title: 'Project update',
      content: 'Version 2 released.',
      proof: {
        kind: 'ai_citation',
        connectorId: 'web-search',
        citationUrl: 'https://example.com/posts/one',
      },
    });
    const second = makeCandidate({
      connectorId: 'rss',
      sourceType: 'feed',
      platform: 'Project Blog',
      url: 'https://blog.example.net/posts/two',
      title: 'Project update',
      content: 'Maintenance starts Friday.',
      proof: {
        kind: 'feed_entry',
        connectorId: 'rss',
        feedUrl: 'https://blog.example.net/feed.xml',
        entryId: 'two',
      },
    });

    expect(deduplicateCandidates([first, second])).toHaveLength(2);
  });
});

describe('candidate diversity selection', () => {
  const makeSocialCandidate = (platform: string, id: string) =>
    makeCandidate({
      connectorId: `${platform.toLocaleLowerCase()}-api`,
      sourceType: 'social',
      platform,
      externalId: id,
      url: `https://${platform.toLocaleLowerCase()}.example/posts/${id}`,
      authorHandle: `@${platform.toLocaleLowerCase()}`,
      proof: {
        kind: 'api_record',
        connectorId: `${platform.toLocaleLowerCase()}-api`,
        externalId: id,
      },
    });

  it('caps each platform at two of five when enough diversity exists', () => {
    const candidates = [
      makeSocialCandidate('Alpha', 'a1'),
      makeSocialCandidate('Alpha', 'a2'),
      makeSocialCandidate('Alpha', 'a3'),
      makeSocialCandidate('Alpha', 'a4'),
      makeSocialCandidate('Beta', 'b1'),
      makeSocialCandidate('Beta', 'b2'),
      makeSocialCandidate('Gamma', 'g1'),
      makeSocialCandidate('Gamma', 'g2'),
    ];

    const selected = selectDiverseCandidates(candidates, 5);

    expect(selected.map((candidate) => candidate.externalId)).toEqual([
      'a1',
      'a2',
      'b1',
      'b2',
      'g1',
    ]);
    expect(
      Math.max(
        ...['Alpha', 'Beta', 'Gamma'].map(
          (platform) => selected.filter((candidate) => candidate.platform === platform).length,
        ),
      ),
    ).toBe(2);
  });

  it('relaxes the cap only to fill a result shortage while retaining order', () => {
    const candidates = [
      makeSocialCandidate('Alpha', 'a1'),
      makeSocialCandidate('Alpha', 'a2'),
      makeSocialCandidate('Alpha', 'a3'),
      makeSocialCandidate('Alpha', 'a4'),
      makeSocialCandidate('Beta', 'b1'),
      makeSocialCandidate('Gamma', 'g1'),
    ];

    expect(
      selectDiverseCandidates(candidates, 5).map((candidate) => candidate.externalId),
    ).toEqual(['a1', 'a2', 'a3', 'b1', 'g1']);
  });

  it('returns an empty result for empty input', () => {
    expect(selectDiverseCandidates([], 5)).toEqual([]);
  });
});
