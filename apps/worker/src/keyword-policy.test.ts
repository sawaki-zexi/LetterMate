import { describe, expect, it } from 'vitest';
import {
  buildKeywordPolicy,
  buildRequiredKeywordPolicy,
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

  it('rejects generated queries for a more specific version continuation', () => {
    const policy = buildKeywordPolicy('gpt-5.7');

    expect(filterQueriesForPolicy([
      'gpt-5.7 release notes',
      'gpt-5.7.1 release notes',
      'GPT-5.7．1 changelog',
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
    expect(candidateMatchesKeyword({
      title: 'GPT-5.7.1 release notes',
      content: 'A more specific patch version.',
    }, policy)).toBe(false);
    expect(candidateMatchesKeyword({
      title: 'GPT-5.7．1 release notes',
      content: 'A fullwidth-dot patch version.',
    }, policy)).toBe(false);
    expect(candidateMatchesKeyword({
      title: 'GPT-5.7. Release notes',
      content: 'Sentence punctuation is not a version continuation.',
    }, policy)).toBe(true);
  });

  it('fails fast for empty or degenerate keywords', () => {
    expect(() => buildKeywordPolicy('  －  ')).toThrow(/letter or number/i);
    expect(() => buildKeywordPolicy('---')).toThrow(/letter or number/i);
  });

  it('preserves valid CJK keywords', () => {
    expect(buildKeywordPolicy('  智能体  ')).toEqual({
      exactPhrase: '智能体',
      aliases: ['智能体'],
    });
  });

  it('requires every precise identifier group while allowing deterministic aliases per group', () => {
    const policy = buildRequiredKeywordPolicy(['OpenAI', 'gpt-5.7'], 'OpenAI gpt-5.7 release');

    expect(candidateMatchesKeyword({
      title: 'OpenAI publishes GPT 5.7 release notes',
      content: null,
    }, policy)).toBe(true);
    expect(candidateMatchesKeyword({
      title: 'GPT-5.7 release notes from another lab',
      content: null,
    }, policy)).toBe(false);
    expect(candidateMatchesKeyword({
      title: 'OpenAI publishes GPT-5.7.1 release notes',
      content: null,
    }, policy)).toBe(false);
  });

  it('normalizes and deduplicates required identifiers and rejects degenerate terms', () => {
    expect(buildRequiredKeywordPolicy([' OpenAI ', 'openai', 'GPT-5.7'])).toMatchObject({
      requiredTermGroups: [
        ['openai'],
        ['gpt-5.7', 'gpt 5.7', 'gpt5.7'],
      ],
    });
    expect(() => buildRequiredKeywordPolicy(['---'])).toThrow(/letter or number/i);
    expect(() => buildRequiredKeywordPolicy([])).toThrow(/required term/i);
  });
});
