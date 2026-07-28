import { describe, expect, it } from 'vitest';
import {
  buildKeywordPolicy,
  candidateMatchesKeyword,
  filterQueriesForPolicy,
} from './keyword-policy.js';

describe('keyword policy', () => {
  it('builds only deterministic punctuation and spacing aliases while preserving versions', () => {
    expect(buildKeywordPolicy('gpt-5.7')).toEqual({
      exactPhrase: 'gpt-5.7',
      aliases: ['gpt-5.7', 'gpt 5.7', 'gpt5.7'],
    });
  });

  it('normalizes Unicode width, case, and whitespace', () => {
    expect(buildKeywordPolicy('  ＧＰＴ－５．７  ')).toEqual({
      exactPhrase: 'gpt-5.7',
      aliases: ['gpt-5.7', 'gpt 5.7', 'gpt5.7'],
    });
  });

  it('keeps only generated queries that retain the precise identifier', () => {
    const policy = buildKeywordPolicy('gpt-5.7');

    expect(filterQueriesForPolicy([
      'gpt-5.7 release notes',
      'latest GPT model',
    ], policy)).toEqual(['gpt-5.7 release notes']);
  });

  it('matches exact phrases and approved aliases in candidate title or content', () => {
    const policy = buildKeywordPolicy('gpt-5.7');

    expect(candidateMatchesKeyword({
      title: 'GPT 5.7 release notes',
      content: 'The maintainers describe the migration path and API changes.',
    }, policy)).toBe(true);
    expect(candidateMatchesKeyword({
      title: 'Weekly model roundup',
      content: 'The article includes a detailed GPT5.7 benchmark and limitations.',
    }, policy)).toBe(true);
  });

  it('rejects generic candidates and partial version matches', () => {
    const policy = buildKeywordPolicy('gpt-5.7');

    expect(candidateMatchesKeyword({
      title: 'The latest GPT models compared',
      content: 'A broad roundup of current AI models.',
    }, policy)).toBe(false);
    expect(candidateMatchesKeyword({
      title: 'GPT-5.70 preview',
      content: 'A different version identifier.',
    }, policy)).toBe(false);
  });

  it('does not match anything for an empty or degenerate keyword', () => {
    const policy = buildKeywordPolicy('  －  ');

    expect(policy.aliases).toEqual([]);
    expect(filterQueriesForPolicy(['latest model'], policy)).toEqual([]);
    expect(candidateMatchesKeyword({ title: 'Any title', content: 'Any body' }, policy)).toBe(false);
  });
});
