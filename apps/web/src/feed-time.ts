import type { FeedItem } from '@lettermate/contracts';
import { startOfDay, startOfMonth, subDays } from 'date-fns';

const labels = ['今天', '昨天', '近 3 天', '近 7 天', '本月更早', '更早'] as const;

export interface FeedTimeGroup {
  label: (typeof labels)[number];
  items: FeedItem[];
}

export function groupFeedItems(items: FeedItem[], now = new Date()): FeedTimeGroup[] {
  const today = startOfDay(now).getTime();
  const yesterday = startOfDay(subDays(now, 1)).getTime();
  const threeDays = startOfDay(subDays(now, 2)).getTime();
  const sevenDays = startOfDay(subDays(now, 6)).getTime();
  const month = startOfMonth(now).getTime();
  const groups = new Map<(typeof labels)[number], FeedItem[]>();

  for (const item of items) {
    const effectiveTime = new Date(item.publishedAt ?? item.discoveredAt).getTime();
    const label = effectiveTime >= today
      ? labels[0]
      : effectiveTime >= yesterday
        ? labels[1]
        : effectiveTime >= threeDays
          ? labels[2]
          : effectiveTime >= sevenDays
            ? labels[3]
            : effectiveTime >= month
              ? labels[4]
              : labels[5];
    const group = groups.get(label);
    if (group) group.push(item);
    else groups.set(label, [item]);
  }

  return labels.flatMap((label) => {
    const groupItems = groups.get(label);
    return groupItems ? [{ label, items: groupItems }] : [];
  });
}
