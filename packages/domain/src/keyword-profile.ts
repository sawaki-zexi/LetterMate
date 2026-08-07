export type KeywordProfileKind = 'entity' | 'domain' | 'unknown';

export interface KeywordProfile {
  kind: KeywordProfileKind;
}

const normalizeKeywordProfileText = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('en-US')
  .replace(/[\u2010-\u2015\u2212]/gu, '-')
  .replace(/\s+/gu, ' ')
  .trim();

const entityPattern = /(?:\b(?:v?\d+(?:\.\d+)+)\b|\b(?:gpt|claude|gemini|llama)[- ]?\d)/iu;
const domainPattern = /(?:\b(?:ai|agent|agents|model|models|software|engineering|research|developer|development|database|security|benchmark|technology|tech)\b|领域|技术|软件|工程|研究|开发|数据库|安全|基准)/iu;

export const classifyKeywordProfile = (keyword: string): KeywordProfile => {
  const normalized = normalizeKeywordProfileText(keyword);
  if (entityPattern.test(normalized)) return { kind: 'entity' };
  if (domainPattern.test(normalized)) return { kind: 'domain' };
  return { kind: 'unknown' };
};
