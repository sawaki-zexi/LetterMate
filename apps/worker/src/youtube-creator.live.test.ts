import { validateSourceCandidate } from '@lettermate/domain';
import { describe, expect, it } from 'vitest';
import { YouTubeCreatorConnector } from './connectors/youtube-creator.js';
import type { SourceQueryPlan } from './connectors/types.js';
import { buildKeywordPolicy } from './keyword-policy.js';

try {
  process.loadEnvFile();
} catch {
  // Environment variables may already be supplied by the test runner.
}

const apiKey = process.env.YOUTUBE_API_KEY;
const channelId = process.env.YOUTUBE_LIVE_CHANNEL_ID;
const enabled = process.env.RUN_LIVE_YOUTUBE_TESTS === '1'
  && Boolean(apiKey?.trim())
  && Boolean(channelId?.trim());

describe.skipIf(!enabled)('YouTube creator live discovery', () => {
  it('returns source-valid public videos for the configured stable channel ID', async () => {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 365 * 24 * 60 * 60 * 1_000);
    const plan: SourceQueryPlan = {
      keyword: channelId!,
      matchPolicy: buildKeywordPolicy(channelId!),
      expandedTerms: [],
      queries: [channelId!],
      sourceTypes: ['video'],
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      maxCandidates: 30,
    };
    const connector = new YouTubeCreatorConnector({ apiKey, channelId: channelId!, pageBudget: 1 });

    const result = await connector.search(plan, new AbortController().signal);
    const valid = result.candidates.map(validateSourceCandidate);

    expect(result.identity?.profileUrl).toBe(`https://www.youtube.com/channel/${channelId}`);
    expect(valid.length).toBeGreaterThan(0);
    expect(valid.every((candidate) => (
      candidate.platform === 'YouTube'
      && candidate.authorHandle === channelId
      && candidate.canonicalUrl.startsWith('https://www.youtube.com/watch?')
    ))).toBe(true);
  });
});
