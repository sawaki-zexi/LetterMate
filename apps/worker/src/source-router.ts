import type { SourceType } from '@lettermate/contracts';
import type { ExpandedTopic } from './ai-gateway.js';
import type { SourceQueryPlan } from './connectors/types.js';
import { buildKeywordPolicy, filterQueriesForPolicy } from './keyword-policy.js';

export interface SourceRoutingInput {
  keyword: string;
  expanded: ExpandedTopic;
  windowStart: string;
  windowEnd: string;
}

const connectorSourceTypes: Record<string, SourceType> = {
  'openrouter-search': 'web',
  'search-brave': 'web',
  'search-tavily': 'web',
  'search-bing': 'web',
  rss: 'feed',
  'twitterapi-io': 'social',
  bluesky: 'social',
  youtube: 'video',
  bilibili: 'video',
  'hacker-news': 'community',
  reddit: 'community',
  github: 'code',
  arxiv: 'paper',
};

const technicalConnectors = [
  'search-tavily',
  'search-bing',
  'openrouter-search',
  'search-brave',
  'rss',
  'hacker-news',
  'arxiv',
  'github',
  'twitterapi-io',
  'bluesky',
];

const productConnectors = [
  'search-tavily',
  'search-bing',
  'openrouter-search',
  'search-brave',
  'rss',
  'twitterapi-io',
  'bluesky',
  'youtube',
  'bilibili',
  'reddit',
];

const balancedConnectors = [
  'openrouter-search',
  'search-brave',
  'search-tavily',
  'search-bing',
  'rss',
  'hacker-news',
  'github',
  'twitterapi-io',
  'bluesky',
  'youtube',
  'bilibili',
];

const productSignal = /\b(?:product|launch|market|business|company|funding|policy|social(?:\s+media)?|society)\b|产品|发布|市场|商业|公司|融资|政策|社会|社交/ui;
const technicalSignal = /\b(?:agent|model|software|code|api|developer|engineering|database|security|algorithm|benchmark|research)\b|智能体|模型|软件|代码|开发|技术|算法|基准|研究/ui;

const unique = (values: readonly string[], limit: number): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();
    if (!trimmed || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
    if (result.length === limit) break;
  }
  return result;
};

export class SourceRouter {
  route(input: SourceRoutingInput): SourceQueryPlan {
    const matchPolicy = buildKeywordPolicy(input.keyword);
    const routeText = [input.keyword, ...input.expanded.terms, ...input.expanded.searchQueries]
      .join(' ');
    const connectorIds = productSignal.test(routeText)
      ? productConnectors
      : technicalSignal.test(routeText)
        ? technicalConnectors
        : balancedConnectors;
    const sourceTypes = unique(
      connectorIds.reduce<SourceType[]>((types, connectorId) => {
        const sourceType = connectorSourceTypes[connectorId];
        if (sourceType !== undefined) types.push(sourceType);
        return types;
      }, []),
      7,
    ) as SourceType[];
    const generatedQueries = filterQueriesForPolicy(
      input.expanded.searchQueries,
      matchPolicy,
    ).slice(0, 1);
    const quotedPhrase = `"${matchPolicy.exactPhrase}"`;
    const intentQueries = matchPolicy.exactPhrase.length === 0 ? [] : [
      `${quotedPhrase} release`,
      `${quotedPhrase} announcement`,
      `${quotedPhrase} changelog`,
      `${quotedPhrase} official`,
      ...(connectorIds.includes('github') ? [`${quotedPhrase} github release`] : []),
      ...(connectorIds.includes('arxiv') ? [`${quotedPhrase} paper`] : []),
      ...(connectorIds.includes('youtube') ? [`${quotedPhrase} official video`] : []),
      ...(connectorIds.includes('twitterapi-io') ? [`${quotedPhrase} official account`] : []),
    ];
    const queries = unique([...generatedQueries, ...intentQueries], 6);

    return {
      keyword: input.keyword,
      matchPolicy,
      expandedTerms: unique(input.expanded.terms, 8),
      queries: queries.length > 0 ? queries : [input.keyword],
      sourceTypes,
      connectorIds: [...connectorIds],
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      maxCandidates: 60,
    };
  }
}
