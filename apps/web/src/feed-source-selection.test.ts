import { describe, expect, it } from 'vitest';
import {
  feedFilterForSource,
  topicSourceSelection,
} from './feed-source-selection.js';

describe('feed source selection', () => {
  it("maps all to the all origin filter", () => {
    expect(feedFilterForSource('all')).toEqual({ origin: 'all' });
  });

  it("maps trend to the trend origin filter", () => {
    expect(feedFilterForSource('trend')).toEqual({ origin: 'trend' });
  });

  it("encodes a topic source selection", () => {
    expect(topicSourceSelection('topic-1')).toBe('topic:topic-1');
  });

  it("maps a topic source selection to a topic filter", () => {
    expect(feedFilterForSource(topicSourceSelection('topic-1'))).toEqual({
      origin: 'topic',
      topicId: 'topic-1',
    });
  });
});
