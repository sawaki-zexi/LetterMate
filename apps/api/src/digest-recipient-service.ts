import {
  digestRecipientSchema,
  digestRecipientVerificationResultSchema,
  type DigestRecipient,
  type DigestRecipientVerificationResult,
} from '@lettermate/contracts';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DigestVerificationQueue } from './digest-verification-queue.js';

const VERIFICATION_TTL_MS = 24 * 60 * 60_000;
const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const RATE_LIMIT_MAX = 5;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const safeRateKey = (value: string): string => createHash('sha256').update(value).digest('hex');

export class DigestRecipientError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super('Digest recipient operation failed');
    this.name = 'DigestRecipientError';
  }
}

interface VerificationRecord {
  id: string;
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface DigestRecipientRepository {
  get(userId: string): Promise<DigestRecipient>;
  begin(input: VerificationRecord, now: Date): Promise<void>;
  confirm(hash: string, now: Date): Promise<boolean>;
}

export class MemoryDigestRecipientRepository implements DigestRecipientRepository {
  readonly recipients = new Map<string, DigestRecipient>();
  readonly verifications = new Map<string, VerificationRecord>();

  constructor(private readonly disableDigest?: (userId: string) => void) {}

  async get(userId: string): Promise<DigestRecipient> {
    return digestRecipientSchema.parse(this.recipients.get(userId) ?? {
      email: `${userId}@example.local`, status: 'unverified', verifiedAt: null,
    });
  }

  async begin(input: VerificationRecord, now: Date): Promise<void> {
    const previous = this.recipients.get(input.userId);
    if (previous?.status === 'suppressed' && previous.email === input.email) {
      throw new DigestRecipientError('DIGEST_RECIPIENT_SUPPRESSED', 409);
    }
    for (const [hash, verification] of this.verifications) {
      if (verification.userId === input.userId && verification.usedAt === null) {
        this.verifications.set(hash, { ...verification, usedAt: now });
      }
    }
    this.recipients.set(input.userId, {
      email: input.email, status: 'pending', verifiedAt: null,
    });
    if (previous?.email !== input.email || previous.status !== 'pending') {
      this.disableDigest?.(input.userId);
    }
    this.verifications.set(input.tokenHash, structuredClone(input));
  }

  async confirm(hash: string, now: Date): Promise<boolean> {
    const verification = this.verifications.get(hash);
    if (!verification || verification.usedAt || verification.expiresAt <= now) return false;
    const recipient = this.recipients.get(verification.userId);
    if (recipient?.email !== verification.email || recipient.status !== 'pending') return false;
    this.verifications.set(hash, { ...verification, usedAt: now });
    this.recipients.set(verification.userId, {
      email: verification.email, status: 'verified', verifiedAt: now.toISOString(),
    });
    return true;
  }
}

export class PrismaDigestRecipientRepository implements DigestRecipientRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(userId: string): Promise<DigestRecipient> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        digestPreference: {
          select: {
            recipientEmail: true, recipientStatus: true, recipientVerifiedAt: true,
          },
        },
      },
    });
    if (!user) throw new DigestRecipientError('NOT_FOUND', 404);
    return digestRecipientSchema.parse({
      email: user.digestPreference?.recipientEmail ?? user.email,
      status: user.digestPreference?.recipientStatus ?? 'unverified',
      verifiedAt: user.digestPreference?.recipientVerifiedAt?.toISOString() ?? null,
    });
  }

  async begin(input: VerificationRecord, now: Date): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.digestPreference.findUnique({
        where: { userId: input.userId },
        select: { recipientEmail: true, recipientStatus: true },
      });
      if (current?.recipientStatus === 'suppressed' && current.recipientEmail === input.email) {
        throw new DigestRecipientError('DIGEST_RECIPIENT_SUPPRESSED', 409);
      }
      await transaction.digestEmailVerification.updateMany({
        where: { userId: input.userId, usedAt: null },
        data: { usedAt: now },
      });
      await transaction.digestPreference.upsert({
        where: { userId: input.userId },
        create: {
          userId: input.userId,
          recipientEmail: input.email,
          recipientStatus: 'pending',
          unsubscribeTokenId: randomUUID(),
        },
        update: {
          enabled: false,
          recipientEmail: input.email,
          recipientStatus: 'pending',
          recipientVerifiedAt: null,
          recipientSuppressionReason: null,
          recipientSuppressedAt: null,
          unsubscribeTokenId: randomUUID(),
        },
      });
      await transaction.digestEmailVerification.create({ data: input });
    });
  }

  async confirm(hash: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const verification = await transaction.digestEmailVerification.findUnique({
        where: { tokenHash: hash },
      });
      if (!verification || verification.usedAt || verification.expiresAt <= now) return false;
      const claimed = await transaction.digestEmailVerification.updateMany({
        where: { id: verification.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return false;
      const preference = await transaction.digestPreference.updateMany({
        where: {
          userId: verification.userId,
          recipientEmail: verification.email,
          recipientStatus: 'pending',
        },
        data: { recipientStatus: 'verified', recipientVerifiedAt: now },
      });
      return preference.count === 1;
    }, { isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel });
  }
}

export interface DigestRecipientRateLimiter {
  assertAllowed(keys: string[], now: Date): void;
}

export class MemoryDigestRecipientRateLimiter implements DigestRecipientRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  assertAllowed(keys: string[], now: Date): void {
    const threshold = now.getTime() - RATE_LIMIT_WINDOW_MS;
    for (const key of keys) {
      const recent = (this.attempts.get(key) ?? []).filter((value) => value > threshold);
      if (recent.length >= RATE_LIMIT_MAX) {
        throw new DigestRecipientError('DIGEST_EMAIL_RATE_LIMITED', 429);
      }
      this.attempts.set(key, recent);
    }
    for (const key of keys) this.attempts.get(key)!.push(now.getTime());
  }
}

export class DigestRecipientService {
  constructor(
    private readonly repository: DigestRecipientRepository,
    private readonly queue: DigestVerificationQueue,
    private readonly publicWebOrigin: string,
    private readonly deliveryConfigured: boolean,
    private readonly rateLimiter: DigestRecipientRateLimiter = new MemoryDigestRecipientRateLimiter(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(userId: string): Promise<DigestRecipient> {
    return this.repository.get(userId);
  }

  async request(userId: string, email: string, clientKey: string): Promise<DigestRecipient> {
    if (!this.deliveryConfigured) {
      throw new DigestRecipientError('DIGEST_DELIVERY_NOT_CONFIGURED', 503);
    }
    const recipient = normalizeEmail(email);
    const now = this.now();
    this.rateLimiter.assertAllowed([
      `user:${safeRateKey(userId)}`,
      `email:${safeRateKey(recipient)}`,
      `client:${safeRateKey(clientKey)}`,
    ], now);
    const token = randomBytes(32).toString('base64url');
    const verification: VerificationRecord = {
      id: randomUUID(), userId, email: recipient, tokenHash: tokenHash(token),
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS), usedAt: null,
    };
    await this.repository.begin(verification, now);
    const url = new URL('/digest/verify', this.publicWebOrigin);
    url.searchParams.set('token', token);
    await this.queue.enqueue({
      verificationId: verification.id,
      recipient,
      verificationUrl: url.toString(),
      expiresAt: verification.expiresAt.toISOString(),
    });
    return this.repository.get(userId);
  }

  async confirm(token: string): Promise<DigestRecipientVerificationResult> {
    if (!await this.repository.confirm(tokenHash(token), this.now())) {
      throw new DigestRecipientError('DIGEST_EMAIL_VERIFICATION_INVALID', 400);
    }
    return digestRecipientVerificationResultSchema.parse({ status: 'verified' });
  }
}
