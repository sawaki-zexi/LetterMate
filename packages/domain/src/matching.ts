export interface MatchableRule {
  keywords: readonly string[];
  synonyms: readonly string[];
  exclusions: readonly string[];
  scope:
    | { mode: 'all' }
    | { mode: 'types'; sourceTypes: readonly ('rss' | 'web')[] }
    | { mode: 'sources'; sourceIds: readonly string[] };
}

export interface MatchCandidate {
  text: string;
  sourceType: 'rss' | 'web';
  sourceId: string;
}

export interface MatchResult {
  matched: boolean;
  reason: string | null;
}

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

export function matchMonitorRule(rule: MatchableRule, candidate: MatchCandidate): MatchResult {
  if (
    (rule.scope.mode === 'types' && !rule.scope.sourceTypes.includes(candidate.sourceType)) ||
    (rule.scope.mode === 'sources' && !rule.scope.sourceIds.includes(candidate.sourceId))
  ) {
    return { matched: false, reason: null };
  }

  const text = normalize(candidate.text);
  if (rule.exclusions.some((term) => text.includes(normalize(term)))) {
    return { matched: false, reason: null };
  }

  const keyword = rule.keywords.find((term) => text.includes(normalize(term)));
  if (keyword) return { matched: true, reason: `keyword:${keyword}` };

  const synonym = rule.synonyms.find((term) => text.includes(normalize(term)));
  if (synonym) return { matched: true, reason: `synonym:${synonym}` };

  return { matched: false, reason: null };
}
