import type { TrustLevel, TrustStatus } from '@lettermate/contracts';

export interface TrustEvidence {
  trustLevel: TrustLevel;
  independenceGroup: string;
  stance: 'supports' | 'contradicts';
}

export interface TrustDecision {
  status: TrustStatus;
  reason: string;
  independentSecondaryCount: number;
}

export function calculateTrust(evidence: readonly TrustEvidence[]): TrustDecision {
  const authoritativeContradiction = evidence.some(
    (item) => item.trustLevel === 'primary' && item.stance === 'contradicts',
  );
  const independentSecondaryCount = new Set(
    evidence
      .filter((item) => item.trustLevel === 'secondary' && item.stance === 'supports')
      .map((item) => item.independenceGroup),
  ).size;

  if (authoritativeContradiction) {
    return {
      status: 'rejected',
      reason: '一级来源提供了明确反证',
      independentSecondaryCount,
    };
  }

  if (evidence.some((item) => item.trustLevel === 'primary' && item.stance === 'supports')) {
    return {
      status: 'confirmed',
      reason: '一级来源直接发布',
      independentSecondaryCount,
    };
  }

  if (independentSecondaryCount >= 2) {
    return {
      status: 'confirmed',
      reason: `${independentSecondaryCount} 个独立二级来源交叉佐证`,
      independentSecondaryCount,
    };
  }

  return {
    status: 'pending',
    reason: '独立可信证据不足',
    independentSecondaryCount,
  };
}

const allowedTransitions: Record<TrustStatus, readonly TrustStatus[]> = {
  pending: ['pending', 'confirmed', 'rejected'],
  confirmed: ['confirmed', 'rejected'],
  rejected: ['rejected'],
};

export function transitionTrustStatus(
  current: TrustStatus,
  next: TrustStatus,
  reason: string,
): TrustStatus {
  if (current !== next && reason.trim().length === 0) {
    throw new Error('A reason is required when trust status changes');
  }
  if (!allowedTransitions[current].includes(next)) {
    throw new Error(`Trust status cannot transition from ${current} to ${next}`);
  }
  return next;
}
