import type { TrustStatus } from '@lettermate/contracts';

export interface NotificationPolicyInput {
  status: TrustStatus;
  priority: 'low' | 'normal' | 'high';
  notifyImmediately: boolean;
  ruleEnabled: boolean;
  excluded: boolean;
}

export function isNotificationEligible(input: NotificationPolicyInput): boolean {
  return (
    input.status === 'confirmed' &&
    input.priority === 'high' &&
    input.notifyImmediately &&
    input.ruleEnabled &&
    !input.excluded
  );
}

export function createNotificationDedupKey(
  userId: string,
  eventId: string,
  revision: 'confirmed' | `correction:${number}` | `evidence:${number}`,
): string {
  if (!userId || !eventId) throw new Error('A user and event are required');
  return `${userId}:${eventId}:${revision}`;
}
