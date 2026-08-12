import {
  digestTestEmailJobDataSchema,
  digestTestEmailQueueName,
  type DigestTestEmailJobData,
} from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { EmailGateway } from './digest-email.js';
import { EmailGatewayError, renderDigestTestEmail } from './digest-email.js';

const LEASE_MS = 10 * 60_000;

interface ClaimedTestEmail {
  id: string;
  userId: string;
  recipient: string;
  leaseUntil: Date;
}

export interface DigestTestEmailDeliveryRepository {
  claim(data: DigestTestEmailJobData, now: Date, leaseUntil: Date): Promise<ClaimedTestEmail | null>;
  succeed(run: ClaimedTestEmail, messageId: string, now: Date): Promise<void>;
  retry(run: ClaimedTestEmail, errorCode: string): Promise<void>;
  fail(run: ClaimedTestEmail, errorCode: string, now: Date): Promise<void>;
}

const SAFE_ERROR_CODES = new Set([
  'EMAIL_TIMEOUT', 'EMAIL_NETWORK_ERROR', 'EMAIL_RATE_LIMITED',
  'EMAIL_PROVIDER_UNAVAILABLE', 'EMAIL_RECIPIENT_REJECTED',
  'EMAIL_AUTHENTICATION_FAILED', 'EMAIL_CONFIRMATION_LOST',
  'EMAIL_IDEMPOTENCY_CONFLICT', 'EMAIL_GATEWAY_UNAVAILABLE',
]);

const safeErrorCode = (value: string): string => (
  SAFE_ERROR_CODES.has(value) ? value : 'EMAIL_GATEWAY_UNAVAILABLE'
);

const assertUpdated = (count: number): void => {
  if (count !== 1) throw new Error('Digest test email lease was lost before state commit');
};

export class PrismaDigestTestEmailDeliveryRepository implements DigestTestEmailDeliveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(
    data: DigestTestEmailJobData,
    now: Date,
    leaseUntil: Date,
  ): Promise<ClaimedTestEmail | null> {
    const claimed = await this.prisma.digestTestEmail.updateMany({
      where: {
        id: data.testEmailId,
        userId: data.userId,
        OR: [
          { status: { in: ['queued', 'retrying'] } },
          { status: 'running', runLeaseUntil: { lte: now } },
        ],
      },
      data: {
        status: 'running', startedAt: now, runLeaseUntil: leaseUntil,
        attemptCount: { increment: 1 }, errorCode: null,
      },
    });
    if (claimed.count !== 1) return null;
    const record = await this.prisma.digestTestEmail.findFirst({
      where: { id: data.testEmailId, userId: data.userId },
      select: { id: true, userId: true, recipientEmail: true },
    });
    return record ? {
      id: record.id, userId: record.userId,
      recipient: record.recipientEmail, leaseUntil,
    } : null;
  }

  async succeed(run: ClaimedTestEmail, messageId: string, now: Date): Promise<void> {
    const result = await this.prisma.digestTestEmail.updateMany({
      where: { id: run.id, userId: run.userId, status: 'running', runLeaseUntil: run.leaseUntil },
      data: {
        status: 'succeeded', providerMessageId: messageId,
        finishedAt: now, runLeaseUntil: null, errorCode: null,
      },
    });
    assertUpdated(result.count);
  }

  async retry(run: ClaimedTestEmail, errorCode: string): Promise<void> {
    const result = await this.prisma.digestTestEmail.updateMany({
      where: { id: run.id, userId: run.userId, status: 'running', runLeaseUntil: run.leaseUntil },
      data: {
        status: 'retrying', runLeaseUntil: null,
        errorCode: safeErrorCode(errorCode),
      },
    });
    assertUpdated(result.count);
  }

  async fail(run: ClaimedTestEmail, errorCode: string, now: Date): Promise<void> {
    const result = await this.prisma.digestTestEmail.updateMany({
      where: { id: run.id, userId: run.userId, status: 'running', runLeaseUntil: run.leaseUntil },
      data: {
        status: 'failed', finishedAt: now, runLeaseUntil: null,
        errorCode: safeErrorCode(errorCode), providerMessageId: null,
      },
    });
    assertUpdated(result.count);
  }
}

export class DigestTestEmailDeliveryService {
  constructor(
    private readonly repository: DigestTestEmailDeliveryRepository,
    private readonly gateway: EmailGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(data: DigestTestEmailJobData, options: { finalAttempt: boolean }): Promise<void> {
    const parsed = digestTestEmailJobDataSchema.parse(data);
    const now = this.now();
    const run = await this.repository.claim(
      parsed, now, new Date(now.getTime() + LEASE_MS),
    );
    if (!run) return;
    try {
      const result = await this.gateway.send(renderDigestTestEmail(run.recipient), {
        idempotencyKey: `digest-test:${run.id}`,
      });
      await this.repository.succeed(run, result.messageId, this.now());
    } catch (error) {
      const failure = error instanceof EmailGatewayError
        ? error
        : new EmailGatewayError('EMAIL_GATEWAY_UNAVAILABLE', true);
      if (failure.retryable && !options.finalAttempt) {
        await this.repository.retry(run, failure.code);
        throw failure;
      }
      await this.repository.fail(run, failure.code, this.now());
    }
  }
}

export const createDigestTestEmailJobHandler = (
  service: Pick<DigestTestEmailDeliveryService, 'run'>,
) => async (job: Job<DigestTestEmailJobData>): Promise<void> => {
  const attempts = job.opts.attempts ?? 1;
  await service.run(digestTestEmailJobDataSchema.parse(job.data), {
    finalAttempt: job.attemptsMade + 1 >= attempts,
  });
};

export function createDigestTestEmailWorker(
  connection: ConnectionOptions,
  service: Pick<DigestTestEmailDeliveryService, 'run'>,
): Worker<DigestTestEmailJobData> {
  return new Worker<DigestTestEmailJobData>(
    digestTestEmailQueueName,
    createDigestTestEmailJobHandler(service),
    { connection },
  );
}
