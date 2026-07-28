import { describe, expect, it } from 'vitest';
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
    const plan = route('AI Agents', [], ['AI Agent Release', 'ai agent release']);

    expect(plan.queries).toEqual(['AI Agent Release']);
  });

  it('deduplicates and bounds bilingual query terms before connector execution', () => {
    const plan = route('AI Agents', ['AI Agents', '智能体', '智能体'], [
      'AI agent release',
      'AI agent release',
      '智能体 发布',
      'agent architecture',
      'agent benchmark',
      'agent security',
      'agent deployment',
    ]);

    expect(plan.expandedTerms).toEqual(['AI Agents', '智能体']);
    expect(plan.queries).toEqual([
      'AI agent release',
      '智能体 发布',
      'agent architecture',
      'agent benchmark',
      'agent security',
      'agent deployment',
    ]);
  });
});
