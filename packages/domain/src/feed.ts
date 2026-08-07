import type { FeedItem, FeedOriginDetail } from '@lettermate/contracts';
import { canonicalizeUrl } from './url.js';

const normalizeFingerprintText = (value: string): string => (
  value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
);

function fingerprint(item: FeedItem): string | null {
  const title = normalizeFingerprintText(item.title);
  const summary = normalizeFingerprintText(item.summary);
  if (title.length === 0 || summary.length < 48) return null;
  return `${title}\u0000${summary}`;
}

function mergeKeys(item: FeedItem): string[] {
  const keys = [`url\u0000${canonicalizeUrl(item.contentKey)}`];
  if (item.externalId) {
    keys.push(`external\u0000${item.platform.toLocaleLowerCase()}\u0000${item.externalId}`);
  }
  const normalizedFingerprint = fingerprint(item);
  if (normalizedFingerprint) keys.push(`fingerprint\u0000${normalizedFingerprint}`);
  return keys;
}

function originKey(origin: FeedOriginDetail): string {
  if (origin.origin === 'topic') return `topic\u0000${origin.topicId}`;
  if (origin.origin === 'creator') return `creator\u0000${origin.creatorId}`;
  return 'trend';
}

const originPriority = (item: FeedItem): number => (
  item.origin === 'topic' ? 0 : item.origin === 'creator' ? 1 : 2
);

function mergeGroup(items: FeedItem[]): FeedItem {
  const representative = items.reduce((selected, item) => (
    originPriority(item) < originPriority(selected) ? item : selected
  ));
  const sourceUrls = [
    ...new Set(items.flatMap((item) => item.sourceUrls.map(canonicalizeUrl))),
  ].slice(0, 8);
  const originsByKey = new Map<string, FeedOriginDetail>();
  for (const item of items) {
    for (const origin of item.origins) originsByKey.set(originKey(origin), origin);
  }
  return {
    ...representative,
    kind: items.some((item) => item.kind === 'hot') ? 'hot' : 'quality',
    sourceUrls,
    origins: [...originsByKey.values()].slice(0, 50),
  };
}

export function mergeFeedItems(items: readonly FeedItem[]): FeedItem[] {
  const parents = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root] ?? root;
    while (parents[index] !== index) {
      const next = parents[index] ?? root;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const keyOwner = new Map<string, number>();
  items.forEach((item, index) => {
    for (const key of mergeKeys(item)) {
      const owner = keyOwner.get(key);
      if (owner === undefined) keyOwner.set(key, index);
      else union(index, owner);
    }
  });
  const groups = new Map<number, FeedItem[]>();
  items.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(item);
    groups.set(root, group);
  });
  return [...groups.values()].map(mergeGroup);
}
