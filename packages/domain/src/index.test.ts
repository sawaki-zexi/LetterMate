import { describe, expect, it } from 'vitest';
import {
  calculateTrust,
  canonicalizeUrl,
  createNotificationDedupKey,
  isNotificationEligible,
  matchMonitorRule,
  transitionTrustStatus,
  type TrustEvidence,
} from './index.js';

const evidence = (
  trustLevel: TrustEvidence['trustLevel'],
  independenceGroup: string,
  stance: TrustEvidence['stance'] = 'supports',
): TrustEvidence => ({ trustLevel, independenceGroup, stance });

describe('trust calculation', () => {
  it('confirms a primary source directly', () => {
    expect(calculateTrust([evidence('primary', 'openai')]).status).toBe('confirmed');
  });

  it('confirms two independent secondary sources', () => {
    expect(
      calculateTrust([
        evidence('secondary', 'reuters'),
        evidence('secondary', 'bbc'),
      ]).status,
    ).toBe('confirmed');
  });

  it('keeps syndicated evidence pending', () => {
    expect(
      calculateTrust([
        evidence('secondary', 'wire-a'),
        evidence('secondary', 'wire-a'),
      ]).status,
    ).toBe('pending');
  });

  it('does not count interest sources toward confirmation', () => {
    expect(
      calculateTrust([
        evidence('secondary', 'reuters'),
        evidence('interest', 'creator-a'),
      ]).status,
    ).toBe('pending');
  });

  it('rejects an event with authoritative contradiction', () => {
    expect(
      calculateTrust([
        evidence('secondary', 'reuters'),
        evidence('primary', 'official', 'contradicts'),
      ]).status,
    ).toBe('rejected');
  });
});

describe('monitor matching', () => {
  const rule = {
    keywords: ['AI Agent'],
    synonyms: ['智能体'],
    exclusions: ['招聘'],
    scope: { mode: 'types' as const, sourceTypes: ['rss' as const] },
  };

  it('matches synonyms case-insensitively within scope', () => {
    expect(matchMonitorRule(rule, { text: '智能体框架发布', sourceType: 'rss', sourceId: 's1' })).toEqual({
      matched: true,
      reason: 'synonym:智能体',
    });
  });

  it('lets an exclusion override a keyword', () => {
    expect(matchMonitorRule(rule, { text: 'AI Agent 招聘', sourceType: 'rss', sourceId: 's1' }).matched).toBe(false);
  });

  it('does not match sources outside scope', () => {
    expect(matchMonitorRule(rule, { text: 'AI Agent release', sourceType: 'web', sourceId: 's2' }).matched).toBe(false);
  });
});

describe('event utility rules', () => {
  it('removes tracking parameters while keeping content parameters', () => {
    expect(canonicalizeUrl('https://Example.com/news?id=42&utm_source=mail#top')).toBe(
      'https://example.com/news?id=42',
    );
  });

  it('allows confirmed high priority notifications exactly by policy', () => {
    expect(
      isNotificationEligible({
        status: 'confirmed',
        priority: 'high',
        notifyImmediately: true,
        ruleEnabled: true,
        excluded: false,
      }),
    ).toBe(true);
  });

  it('builds a stable per-user event key', () => {
    expect(createNotificationDedupKey('user-1', 'event-1', 'confirmed')).toBe(
      'user-1:event-1:confirmed',
    );
  });

  it('requires a reason when status changes', () => {
    expect(() => transitionTrustStatus('confirmed', 'rejected', '')).toThrow(/reason/i);
  });
});
