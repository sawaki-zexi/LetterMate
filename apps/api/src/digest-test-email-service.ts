import {
  digestTestEmailSchema,
  type DigestTestEmail,
} from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { DigestRecipientEligibilityStore } from './digest-service.js';
import type { DigestTestEmailQueue } from './digest-test-email-queue.js';

const IDEMPOTENCY_BUCKET_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60 * 60_000;
const RATE_LIMIT_MAX = 3;

export class DigestTestEmailError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'DigestTestEmailError';
  }
}

interface TestEmailRecord extends DigestTestEmail {
  userId: string;
  recipientEmail: string;
  idempotencyBucket: string;
}

export interface DigestTestEmailRepository {
  createOrReuse(input: {
    id: string;
    userId: string;
    recipientEmail: string;
    idempotencyBucket: string;
    now: Date;
    rateWindowStart: Date;
  }): Promise<{ record: TestEmailRecord; created: boolean }>;
  get(userId: string, id: string): Promise<DigestTestEmail | null>;
  markEnqueueFailed(userId: string, id: string, now: Date): Promise<void>;
}

const publicRecord = (record: TestEmailRecord): DigestTestEmail => digestTestEmailSchema.parse({
  id: record.id,
  status: record.status,
  createdAt: record.createdAt,
  finishedAt: record.finishedAt,
  errorCode: record.errorCode,
});

export class MemoryDigestTestEmailRepository implements DigestTestEmailRepository {
  readonly records = new Map<string, TestEmailRecord>();

  async createOrReuse(input: {
    id: string; userId: string; recipientEmail: string; idempotencyBucket: string;
    now: Date; rateWindowStart: Date;
  }): Promise<{ record: TestEmailRecord; created: boolean }> {
    const existing = [...this.records.values()].find((record) => (
      record.userId === input.userId && record.idempotencyBucket === input.idempotencyBucket
    ));
    if (existing) return { record: structuredClone(existing), created: false };
    const recent = [...this.records.values()].filter((record) => (
      record.userId === input.userId && new Date(record.createdAt) >= input.rateWindowStart
    ));
    if (recent.length >= RATE_LIMIT_MAX) {
      throw new DigestTestEmailError('DIGEST_TEST_EMAIL_RATE_LIMITED', 429, '测试邮件请求过于频繁');
    }
    const record: TestEmailRecord = {
      id: input.id, userId: input.userId, recipientEmail: input.recipientEmail,
      idempotencyBucket: input.idempotencyBucket, status: 'queued',
      createdAt: input.now.toISOString(), finishedAt: null, errorCode: null,
    };
    this.records.set(record.id, record);
    return { record: structuredClone(record), created: true };
  }

  async get(userId: string, id: string): Promise<DigestTestEmail | null> {
    const record = this.records.get(id);
    return record?.userId === userId ? publicRecord(record) : null;
  }

  async markEnqueueFailed(userId: string, id: string, now: Date): Promise<void> {
    const record = this.records.get(id);
    if (record?.userId !== userId) return;
    this.records.set(id, {
      ...record, status: 'failed', finishedAt: now.toISOString(),
      errorCode: 'DIGEST_TEST_EMAIL_QUEUE_UNAVAILABLE',
    });
  }
}

export class PrismaDigestTestEmailRepository implements DigestTestEmailRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createOrReuse(input: {
    id: string; userId: string; recipientEmail: string; idempotencyBucket: string;
    now: Date; rateWindowStart: Date;
  }): Promise<{ record: TestEmailRecord; created: boolean }> {
    return this.prisma.$transaction(async (transaction) => {
      const lockKey = `digest-test:${input.userId}`;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const existing = await transaction.digestTestEmail.findUnique({
        where: {
          userId_idempotencyBucket: {
            userId: input.userId, idempotencyBucket: input.idempotencyBucket,
          },
        },
      });
      if (existing) return { record: this.toRecord(existing), created: false };
      const recent = await transaction.digestTestEmail.count({
        where: { userId: input.userId, createdAt: { gte: input.rateWindowStart } },
      });
      if (recent >= RATE_LIMIT_MAX) {
        throw new DigestTestEmailError('DIGEST_TEST_EMAIL_RATE_LIMITED', 429, '测试邮件请求过于频繁');
      }
      const created = await transaction.digestTestEmail.create({ data: {
        id: input.id,
        userId: input.userId,
        recipientEmail: input.recipientEmail,
        idempotencyBucket: input.idempotencyBucket,
        createdAt: input.now,
      } });
      return { record: this.toRecord(created), created: true };
    });
  }

  async get(userId: string, id: string): Promise<DigestTestEmail | null> {
    const record = await this.prisma.digestTestEmail.findFirst({ where: { id, userId } });
    return record ? publicRecord(this.toRecord(record)) : null;
  }

  async markEnqueueFailed(userId: string, id: string, now: Date): Promise<void> {
    await this.prisma.digestTestEmail.updateMany({
      where: { id, userId, status: 'queued' },
      data: {
        status: 'failed', finishedAt: now,
        errorCode: 'DIGEST_TEST_EMAIL_QUEUE_UNAVAILABLE',
      },
    });
  }

  private toRecord(record: {
    id: string; userId: string; recipientEmail: string; idempotencyBucket: string;
    status: string; createdAt: Date; finishedAt: Date | null; errorCode: string | null;
  }): TestEmailRecord {
    return {
      id: record.id, userId: record.userId, recipientEmail: record.recipientEmail,
      idempotencyBucket: record.idempotencyBucket,
      status: digestTestEmailSchema.shape.status.parse(record.status),
      createdAt: record.createdAt.toISOString(),
      finishedAt: record.finishedAt?.toISOString() ?? null,
      errorCode: record.errorCode,
    };
  }
}

export class DigestTestEmailService {
  constructor(
    private readonly repository: DigestTestEmailRepository,
    private readonly recipients: DigestRecipientEligibilityStore,
    private readonly queue: DigestTestEmailQueue,
    private readonly deliveryConfigured: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async request(userId: string): Promise<DigestTestEmail> {
    if (!this.deliveryConfigured) {
      throw new DigestTestEmailError(
        'DIGEST_DELIVERY_NOT_CONFIGURED', 503, '邮件投递尚未配置',
      );
    }
    const recipient = await this.recipients.get(userId);
    if (!recipient.email || recipient.status !== 'verified') {
      throw new DigestTestEmailError(
        'DIGEST_RECIPIENT_NOT_VERIFIED', 409, '请先验证收件邮箱',
      );
    }
    const now = this.now();
    const addressKey = createHash('sha256').update(recipient.email).digest('hex').slice(0, 16);
    const bucket = `${Math.floor(now.getTime() / IDEMPOTENCY_BUCKET_MS)}:${addressKey}`;
    const result = await this.repository.createOrReuse({
      id: randomUUID(), userId, recipientEmail: recipient.email,
      idempotencyBucket: bucket, now,
      rateWindowStart: new Date(now.getTime() - RATE_WINDOW_MS),
    });
    if (result.created) {
      try {
        await this.queue.enqueue({ testEmailId: result.record.id, userId });
      } catch {
        await this.repository.markEnqueueFailed(userId, result.record.id, now);
        throw new DigestTestEmailError(
          'DIGEST_TEST_EMAIL_QUEUE_UNAVAILABLE', 503, '测试邮件暂时无法排队',
        );
      }
    }
    return publicRecord(result.record);
  }

  async get(userId: string, id: string): Promise<DigestTestEmail> {
    const record = await this.repository.get(userId, id);
    if (!record) throw new DigestTestEmailError('DIGEST_TEST_EMAIL_NOT_FOUND', 404, '测试邮件不存在');
    return record;
  }
}
