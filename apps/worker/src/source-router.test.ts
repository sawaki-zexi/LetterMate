import { describe, expect, it } from 'vitest';
import { filterQueriesForPolicy } from './keyword-policy.js';
import { SourceRouter } from './source-router.js';

const route = (keyword: string, terms: string[] = [], searchQueries: string[] = []) => (
  new SourceRouter().route({
    keyword,
    expanded: { terms, searchQueries },
    windowStart: '2026-07-20T00:00:00.000Z',
    windowEnd: '2026-07-27T00:00:00.000Z',
  })
);

describe('SourceRouter', () => {
  it('fails fast instead of emitting queries for a degenerate keyword', () => {
    expect(() => route('---', [], ['latest model'])).toThrow(/letter or number/i);
  });

  it('keeps versioned topic queries precise and carries the match policy', () => {
    const plan = route('gpt-5.7', ['GPT', 'latest model'], [
      'gpt-5.7 release notes',
      'latest GPT model',
    ]);

    expect(plan.matchPolicy).toEqual({
      exactPhrase: 'gpt-5.7',
      aliases: ['gpt-5.7', 'gpt 5.7', 'gpt5.7'],
    });
    expect(plan.queries).toContain('gpt-5.7 release notes');
    expect(plan.queries).not.toContain('latest GPT model');
    expect(filterQueriesForPolicy(plan.queries, plan.matchPolicy!)).toEqual(plan.queries);
    expect(plan.queries.some((query) => query.includes('gpt-5.7'))).toBe(true);
    expect(plan.queries.length).toBeLessThanOrEqual(6);
  });

  it('adds deterministic release, announcement, changelog, and official intents', () => {
    const plan = route('gpt-5.7', [], []);

    expect(plan.queries).toEqual(expect.arrayContaining([
      '"gpt-5.7" release',
      '"gpt-5.7" announcement',
      '"gpt-5.7" changelog',
      '"gpt-5.7" official',
    ]));
  });

  it('prioritizes code, paper, and technical community connectors for technical topics', () => {
    const plan = route('AI agent runtime architecture', ['agent runtime'], ['agent runtime release']);

    expect(plan.connectorIds).toEqual(expect.arrayContaining([
      'github',
      'arxiv',
      'hacker-news',
      'rss',
    ]));
    expect(plan.connectorIds).not.toContain('youtube');
    expect(plan.sourceTypes).toEqual(expect.arrayContaining(['code', 'paper', 'community', 'feed']));
    expect(plan.maxCandidates).toBeLessThanOrEqual(60);
  });

  it('prioritizes search, social, and video connectors for product and business topics', () => {
    const plan = route('OpenAI 新产品发布与市场反应', ['product launch'], ['OpenAI product launch']);

    expect(plan.connectorIds).toEqual(expect.arrayContaining([
      'openrouter-search',
      'twitterapi-io',
      'bluesky',
      'youtube',
      'bilibili',
    ]));
    expect(plan.connectorIds).not.toContain('arxiv');
    expect(plan.sourceTypes).toEqual(expect.arrayContaining(['web', 'social', 'video']));
  });

  it('recognizes Chinese technical topics when selecting high-signal technical connectors', () => {
    const plan = route('智能体模型推理框架研究', [], ['智能体架构论文']);

    expect(plan.connectorIds).toEqual(expect.arrayContaining([
      'github',
      'arxiv',
      'hacker-news',
    ]));
    expect(plan.connectorIds).not.toContain('youtube');
  });

  it('prioritizes search, social, and video connectors for social topics', () => {
    const plan = route('社交媒体平台变化', [], ['social media trends']);

    expect(plan.connectorIds).toEqual(expect.arrayContaining([
      'search-brave',
      'twitterapi-io',
      'youtube',
      'reddit',
    ]));
    expect(plan.connectorIds).not.toContain('arxiv');
  });

  it('deduplicates English query variants without consuming extra query budget', () => {
    const plan = route('AI Agents', [], ['AI Agents Release', 'ai agents release']);

    expect(plan.queries[0]).toBe('AI Agents Release');
    expect(plan.queries).not.toContain('ai agents release');
    expect(plan.queries).toHaveLength(6);
  });

  it('deduplicates and bounds bilingual query terms before connector execution', () => {
    const plan = route('AI Agents', ['AI Agents', '智能体', '智能体'], [
      'AI Agents release',
      'AI Agents release',
      '智能体 发布',
      'agent architecture',
      'agent benchmark',
      'agent security',
      'agent deployment',
    ]);

    expect(plan.expandedTerms).toEqual(['AI Agents', '智能体']);
    expect(plan.queries[0]).toBe('AI Agents release');
    expect(plan.queries).toHaveLength(6);
    expect(filterQueriesForPolicy(plan.queries, plan.matchPolicy!)).toEqual(plan.queries);
  });
});
