import { describe, expect, it } from 'vitest';
import {
  eventSchema,
  monitorRuleInputSchema,
  sourceSchema,
} from './index.js';

describe('public contracts', () => {
  it('rejects a monitor rule without a keyword', () => {
    expect(() =>
      monitorRuleInputSchema.parse({
        name: 'AI',
        keywords: [],
        synonyms: [],
        exclusions: [],
        scope: { mode: 'all' },
        priority: 'normal',
        notifyImmediately: false,
      }),
    ).toThrow();
  });

  it('requires evidence-backed event timestamps', () => {
    expect(() =>
      eventSchema.parse({
        id: 'event-1',
        title: 'Release',
        status: 'confirmed',
        firstPublishedAt: 'not-a-date',
      }),
    ).toThrow();
  });

  it('does not allow a blocked source to appear enabled', () => {
    expect(() =>
      sourceSchema.parse({
        id: 'source-1',
        name: 'Blocked feed',
        type: 'rss',
        trustLevel: 'secondary',
        complianceStatus: 'blocked',
        enabled: true,
      }),
    ).toThrow();
  });
});
