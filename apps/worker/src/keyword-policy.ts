export interface KeywordPolicy {
  exactPhrase: string;
  aliases: string[];
  requiredTermGroups?: string[][];
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
    const hasVersionContinuation = /\d$/u.test(alias)
      && after === '.'
      && /\d/u.test(value[offset + alias.length + 1] ?? '');
    const hasTrailingBoundary = !hasVersionContinuation
      && (!endsWithAsciiWord || after === undefined || !/[a-z0-9]/u.test(after));
    if (hasLeadingBoundary && hasTrailingBoundary) return true;
    offset = value.indexOf(alias, offset + 1);
  }
  return false;
};

const textMatchesPolicy = (value: string, policy: KeywordPolicy): boolean => {
  const normalized = normalizeText(value);
  if (policy.requiredTermGroups !== undefined) {
    return policy.requiredTermGroups.length > 0 && policy.requiredTermGroups.every(
      (aliases) => aliases.some((alias) => containsAlias(normalized, alias)),
    );
  }
  if (policy.aliases.length === 0) return false;
  return policy.aliases.some((alias) => containsAlias(normalized, alias));
};

export const buildKeywordPolicy = (keyword: string): KeywordPolicy => {
  const exactPhrase = normalizeText(keyword);
  if (!/[\p{L}\p{N}]/u.test(exactPhrase)) {
    throw new Error('Keyword must contain at least one Unicode letter or number');
  }
  const parts = exactPhrase.split(/[\s-]+/u).filter(Boolean);
  const aliases = unique([
    exactPhrase,
    parts.join(' '),
    parts.join(''),
  ]);
  return { exactPhrase, aliases };
};

export const buildRequiredKeywordPolicy = (
  requiredTerms: readonly string[],
  queryPhrase?: string,
): KeywordPolicy => {
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const term of requiredTerms) {
    const policy = buildKeywordPolicy(term);
    if (seen.has(policy.exactPhrase)) continue;
    seen.add(policy.exactPhrase);
    groups.push(policy.aliases);
  }
  if (groups.length === 0) throw new Error('At least one required term is needed');
  const phrase = queryPhrase?.trim() || requiredTerms.join(' ');
  const base = buildKeywordPolicy(phrase);
  return { ...base, requiredTermGroups: groups };
};

export const filterQueriesForPolicy = (
  queries: readonly string[],
  policy: KeywordPolicy,
): string[] => queries.filter((query) => textMatchesPolicy(query, policy));

export const candidateMatchesKeyword = (
  candidate: KeywordCandidateText,
  policy: KeywordPolicy,
): boolean => textMatchesPolicy(
  [candidate.title, candidate.content]
    .filter((value): value is string => value !== null)
    .join(' '),
  policy,
);
