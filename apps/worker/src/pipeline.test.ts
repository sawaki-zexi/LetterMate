import { describe, expect, it, vi } from 'vitest';
import {
  ProcessingPipeline,
  SafeSourceFetcher,
  SourcePolicyError,
  calculateRetryDelay,
  type CollectedItem,
} from './pipeline.js';

const primaryItem: CollectedItem = {
  source: {
    id: 'official', name: 'Official', type: 'rss', trustLevel: 'primary',
    complianceStatus: 'allowed', independenceGroup: 'official', enabled: true,
  },
  url: 'https://example.com/release',
  title: 'Agent Studio released',
  body: 'Official release details',
  publishedAt: '2026-07-24T06:30:00.000Z',
};

describe('processing pipeline', () => {
  it('continues trust evaluation when AI is unavailable', async () => {
    const pipeline = new ProcessingPipeline({
      analyze: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    });

    const event = await pipeline.process(primaryItem);

    expect(event.status).toBe('confirmed');
    expect(event.summaryStatus).toBe('unavailable');
    expect(event.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses an AI summary without letting AI choose status', async () => {
    const pipeline = new ProcessingPipeline({
      analyze: vi.fn().mockResolvedValue({ summary: '中文摘要', suggestedStatus: 'rejected' }),
    });

    const event = await pipeline.process(primaryItem);

    expect(event.status).toBe('confirmed');
    expect(event.summary).toBe('中文摘要');
  });
});

describe('collector safety', () => {
  it('does not fetch a source that is not allowed', async () => {
    const transport = vi.fn();
    const fetcher = new SafeSourceFetcher(transport);
    await expect(fetcher.fetch({ ...primaryItem.source, complianceStatus: 'blocked', enabled: false }, primaryItem.url))
      .rejects.toBeInstanceOf(SourcePolicyError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a redirect to a private network address', async () => {
    const fetcher = new SafeSourceFetcher(async () => ({
      finalUrl: 'http://127.0.0.1/admin',
      status: 200,
      body: 'private',
    }));

    await expect(fetcher.fetch(primaryItem.source, primaryItem.url)).rejects.toMatchObject({
      code: 'SOURCE_ADDRESS_BLOCKED',
    });
  });

  it('rejects a URL outside the configured source host', async () => {
    const fetcher = new SafeSourceFetcher(async () => ({ finalUrl: primaryItem.url, status: 200, body: 'ok' }));
    await expect(fetcher.fetch({ ...primaryItem.source, baseUrl: 'https://allowed.example/feed' }, 'https://other.example/story'))
      .rejects.toMatchObject({ code: 'SOURCE_HOST_BLOCKED' });
  });

  it('honors Retry-After and otherwise applies capped exponential backoff', () => {
    expect(calculateRetryDelay(2, '15')).toBe(15_000);
    expect(calculateRetryDelay(10)).toBe(300_000);
  });
});
