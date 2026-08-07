import { describe, expect, it } from 'vitest';
import { classifyKeywordProfile } from './keyword-profile.js';

describe('keyword profile', () => {
  it('classifies concrete versioned identifiers as entities', () => {
    expect(classifyKeywordProfile('gpt-5.7')).toEqual({ kind: 'entity' });
  });

  it('classifies broad technical terms as domains', () => {
    expect(classifyKeywordProfile('AI Agent')).toEqual({ kind: 'domain' });
  });

  it('falls back to unknown without broadening an unfamiliar keyword', () => {
    expect(classifyKeywordProfile('Project Aurora')).toEqual({ kind: 'unknown' });
  });
});
