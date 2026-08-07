import type { DiscoveryCandidate, InterestTagExtraction } from '@lettermate/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  ContentInterestTagger,
  INTEREST_EXTRACTOR_VERSION,
  INTEREST_TAXONOMY_VERSION,
  normalizeInterestTags,
  type ContentInterestTagRepository,
  type InterestTagGateway,
} from './content-interest-tagger.js';

const candidate = (url: string): DiscoveryCandidate => ({
  kind: 'quality',
  title: 'GPT-5.7 发布说明',
  summary: '官方说明了模型更新。',
  reason: '值得关注版本变化。',
  sourceUrls: [url],
  publishedAt: '2026-08-08T08:00:00.000Z',
  sourceType: 'web',
  platform: 'OpenAI',
  authorName: 'OpenAI',
  authorHandle: null,
  externalId: null,
  provenanceKind: 'fetched_page',
});

describe('content interest tagger', () => {
  it('deduplicates tags deterministically and keeps the strongest confidence', () => {
    expect(normalizeInterestTags({
      schemaVersion: 1,
      tags: [
        { slug: 'release', displayName: '发布', kind: 'content_type', confidence: 0.7 },
        { slug: 'gpt-5-7', displayName: 'GPT-5.7', kind: 'entity', confidence: 0.9 },
        { slug: 'release', displayName: '版本发布', kind: 'content_type', confidence: 0.8 },
      ],
    })).toEqual([
      { slug: 'gpt-5-7', displayName: 'GPT-5.7', kind: 'entity', confidence: 0.9 },
      { slug: 'release', displayName: '版本发布', kind: 'content_type', confidence: 0.8 },
    ]);
  });

  it('persists tags under the canonical content key and fixed versions', async () => {
    const save = vi.fn<ContentInterestTagRepository['save']>().mockResolvedValue(undefined);
    const extraction: InterestTagExtraction = {
      schemaVersion: 1,
      tags: [{ slug: 'gpt-5-7', displayName: 'GPT-5.7', kind: 'entity', confidence: 0.9 }],
    };
    const gateway: InterestTagGateway = { extractInterestTags: vi.fn().mockResolvedValue(extraction) };
    const tagger = new ContentInterestTagger({ save }, gateway);

    await expect(tagger.tagCandidates([
      candidate('https://twitter.com/openai/status/42?utm_source=feed'),
      candidate('https://x.com/openai/status/42'),
    ])).resolves.toEqual([{
      contentKey: 'https://x.com/openai/status/42', tagged: true, tagCount: 1,
    }]);
    expect(save).toHaveBeenCalledWith({
      contentKey: 'https://x.com/openai/status/42',
      tags: extraction.tags,
      taxonomyVersion: INTEREST_TAXONOMY_VERSION,
      extractorVersion: INTEREST_EXTRACTOR_VERSION,
    });
  });

  it('contains extraction and persistence failures without rejecting qualified content', async () => {
    const gateway: InterestTagGateway = {
      extractInterestTags: vi.fn().mockRejectedValue(new Error('AI unavailable')),
    };
    const repository: ContentInterestTagRepository = { save: vi.fn() };
    const tagger = new ContentInterestTagger(repository, gateway);

    await expect(tagger.tagCandidates([candidate('https://example.com/article')]))
      .resolves.toEqual([{
        contentKey: 'https://example.com/article', tagged: false, tagCount: 0,
      }]);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
