import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { AiGatewayError } from './ai-gateway.js';
import {
  CodedUnrecoverableError,
  isExplicitlyNonRetryable,
  toWorkerFailure,
} from './retry-policy.js';

describe('worker retry policy', () => {
  it('preserves retryable failures for BullMQ backoff', () => {
    const failure = new AiGatewayError('AI_RATE_LIMITED', 'Rate limited', true, 10_000);
    expect(isExplicitlyNonRetryable(failure)).toBe(false);
    expect(toWorkerFailure(failure)).toBe(failure);
  });

  it('converts explicit terminal failures to a coded BullMQ unrecoverable error', () => {
    const failure = new AiGatewayError('AI_AUTH_FAILED', 'Private provider message', false);
    const converted = toWorkerFailure(failure);

    expect(isExplicitlyNonRetryable(failure)).toBe(true);
    expect(converted).toBeInstanceOf(UnrecoverableError);
    expect(converted).toBeInstanceOf(CodedUnrecoverableError);
    expect(converted).toMatchObject({ code: 'AI_AUTH_FAILED' });
    expect(JSON.stringify(converted)).not.toContain('Private provider message');
  });

  it('uses a bounded fallback code for an unsafe structural error', () => {
    expect(toWorkerFailure({ retryable: false, code: 'private user@example.com' }))
      .toMatchObject({ code: 'NON_RETRYABLE_FAILURE' });
  });
});
