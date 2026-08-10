import { UnrecoverableError } from 'bullmq';

const safeFailureCode = (error: unknown): string => {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return 'NON_RETRYABLE_FAILURE';
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string'
    && code.length > 0
    && code.length <= 100
    && /^[A-Z0-9_:-]+$/.test(code)
    ? code
    : 'NON_RETRYABLE_FAILURE';
};

export const isExplicitlyNonRetryable = (error: unknown): boolean => (
  typeof error === 'object'
  && error !== null
  && 'retryable' in error
  && (error as { retryable?: unknown }).retryable === false
);

export class CodedUnrecoverableError extends UnrecoverableError {
  constructor(public readonly code: string) {
    super('Worker operation failed with a non-retryable error');
    this.name = 'CodedUnrecoverableError';
  }
}

export const toWorkerFailure = (error: unknown): unknown => (
  isExplicitlyNonRetryable(error)
    ? new CodedUnrecoverableError(safeFailureCode(error))
    : error
);
