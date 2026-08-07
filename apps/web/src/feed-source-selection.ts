import type { FeedOrigin } from '@lettermate/contracts';

export type FeedSourceSelection = 'all' | 'trend' | 'creator' | `topic:${string}`;

export interface FeedSourceFilter {
  origin: FeedOrigin;
  topicId?: string;
}

export function topicSourceSelection(topicId: string): FeedSourceSelection {
  return `topic:${topicId}`;
}

export function feedFilterForSource(selection: FeedSourceSelection): FeedSourceFilter {
  if (selection === 'all' || selection === 'trend' || selection === 'creator') {
    return { origin: selection };
  }

  return {
    origin: 'topic',
    topicId: selection.slice('topic:'.length),
  };
}
