export interface KeywordPolicy {
  exactPhrase: string;
  aliases: string[];
}

export interface KeywordCandidateText {
  title: string | null;
  content: string | null;
}

const normalizeText = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('en-US')
  .replace(/[\u2010-\u2015\u2212]/gu, '-')
  .replace(/\s+/gu, ' ')
  .trim();

const unique = (values: readonly string[]): string[] => (
  [...new Set(values.filter(Boolean))]
);

const containsAlias = (value: string, alias: string): boolean => {
  let offset = value.indexOf(alias);
  while (offset >= 0) {
    const before = value[offset - 1];
    const after = value[offset + alias.length];
    const startsWithAsciiWord = /^[a-z0-9]/u.test(alias);
    const endsWithAsciiWord = /[a-z0-9]$/u.test(alias);
    const hasLeadingBoundary = !startsWithAsciiWord || before === undefined || !/[a-z0-9]/u.test(before);
    const hasTrailingBoundary = !endsWithAsciiWord || after === undefined || !/[a-z0-9]/u.test(after);
    if (hasLeadingBoundary && hasTrailingBoundary) return true;
    offset = value.indexOf(alias, offset + 1);
  }
  return false;
};

const textMatchesPolicy = (value: string, policy: KeywordPolicy): boolean => {
  if (policy.aliases.length === 0) return false;
  const normalized = normalizeText(value);
  return policy.aliases.some((alias) => containsAlias(normalized, alias));
};

export const buildKeywordPolicy = (keyword: string): KeywordPolicy => {
  const exactPhrase = normalizeText(keyword);
  if (!/[\p{L}\p{N}]/u.test(exactPhrase)) {
    return { exactPhrase: '', aliases: [] };
  }
  const parts = exactPhrase.split(/[\s-]+/u).filter(Boolean);
  const aliases = unique([
    exactPhrase,
    parts.join(' '),
    parts.join(''),
  ]);
  return { exactPhrase, aliases };
};

export const filterQueriesForPolicy = (
  queries: readonly string[],
  policy: KeywordPolicy,
): string[] => queries.filter((query) => textMatchesPolicy(query, policy));

export const candidateMatchesKeyword = (
  candidate: KeywordCandidateText,
  policy: KeywordPolicy,
): boolean => [candidate.title, candidate.content]
  .some((value) => value !== null && textMatchesPolicy(value, policy));
