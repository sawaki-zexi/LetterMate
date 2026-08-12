import { describe, expect, it, vi } from 'vitest';
import type { DigestVerificationQueue } from './digest-verification-queue.js';
import {
  DigestRecipientError,
  DigestRecipientService,
  MemoryDigestRecipientRateLimiter,
  MemoryDigestRecipientRepository,
  PrismaDigestRecipientRepository,
} from './digest-recipient-service.js';
import type { PrismaClient } from '@prisma/client';

class RecordingVerificationQueue implements DigestVerificationQueue {
  readonly jobs: Parameters<DigestVerificationQueue['enqueue']>[0][] = [];
  async enqueue(data: Parameters<DigestVerificationQueue['enqueue']>[0]): Promise<void> {
    this.jobs.push(structuredClone(data));
  }
  async close(): Promise<void> {}
}

describe('digest recipient verification', () => {
  it('stores only the token hash and confirms a pending recipient once', async () => {
    const repository = new MemoryDigestRecipientRepository();
    const queue = new RecordingVerificationQueue();
    const service = new DigestRecipientService(
      repository,
      queue,
      'https://app.example.com',
      true,
      new MemoryDigestRecipientRateLimiter(),
      () => new Date('2026-08-12T08:00:00.000Z'),
    );

    await expect(service.request('user-a', ' Student@Example.com ', '198.51.100.10'))
      .resolves.toEqual({
        email: 'student@example.com', status: 'pending', verifiedAt: null,
      });
    expect(queue.jobs).toHaveLength(1);
    const verificationUrl = new URL(queue.jobs[0]!.verificationUrl);
    const token = verificationUrl.searchParams.get('token');
    expect(token).toBeTruthy();
    expect(verificationUrl.origin).toBe('https://app.example.com');
    expect([...repository.verifications.keys()]).not.toContain(token);

    await expect(service.confirm(token!)).resolves.toEqual({ status: 'verified' });
    await expect(service.get('user-a')).resolves.toEqual({
      email: 'student@example.com',
      status: 'verified',
      verifiedAt: '2026-08-12T08:00:00.000Z',
    });
    await expect(service.confirm(token!)).rejects.toMatchObject({
      code: 'DIGEST_EMAIL_VERIFICATION_INVALID', status: 400,
    });
  });

  it('invalidates an older pending token when the recipient changes', async () => {
    const repository = new MemoryDigestRecipientRepository();
    const queue = new RecordingVerificationQueue();
    const service = new DigestRecipientService(
      repository, queue, 'https://app.example.com', true,
    );

    await service.request('user-a', 'first@example.com', 'client-a');
    const first = new URL(queue.jobs[0]!.verificationUrl).searchParams.get('token')!;
    await service.request('user-a', 'second@example.com', 'client-a');
    const second = new URL(queue.jobs[1]!.verificationUrl).searchParams.get('token')!;

    await expect(service.confirm(first)).rejects.toBeInstanceOf(DigestRecipientError);
    await expect(service.confirm(second)).resolves.toEqual({ status: 'verified' });
    await expect(service.get('user-a')).resolves.toMatchObject({
      email: 'second@example.com', status: 'verified',
    });
  });

  it('pauses the memory digest preference whenever verification is restarted', async () => {
    const disableDigest = vi.fn();
    const repository = new MemoryDigestRecipientRepository(disableDigest);
    const service = new DigestRecipientService(
      repository, new RecordingVerificationQueue(), 'https://app.example.com', true,
    );

    await service.request('user-a', 'student@example.com', 'client-a');
    expect(disableDigest).toHaveBeenCalledWith('user-a');
  });

  it('atomically pauses the persisted digest while changing its recipient', async () => {
    const transaction = {
      digestEmailVerification: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({}),
      },
      digestPreference: {
        findUnique: vi.fn().mockResolvedValue({
          recipientEmail: 'old@example.com', recipientStatus: 'verified',
        }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as PrismaClient;
    const repository = new PrismaDigestRecipientRepository(prisma);
    const now = new Date('2026-08-12T08:00:00.000Z');

    await repository.begin({
      id: 'verification-1', userId: 'user-a', email: 'new@example.com',
      tokenHash: 'hash', expiresAt: new Date('2026-08-13T08:00:00.000Z'), usedAt: null,
    }, now);

    expect(transaction.digestPreference.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-a' },
      create: {
        userId: 'user-a', recipientEmail: 'new@example.com', recipientStatus: 'pending',
        unsubscribeTokenId: expect.any(String),
      },
      update: {
        enabled: false, recipientEmail: 'new@example.com',
        recipientStatus: 'pending', recipientVerifiedAt: null,
        recipientSuppressionReason: null, recipientSuppressedAt: null,
        unsubscribeTokenId: expect.any(String),
      },
    });
  });

  it('requires a configured delivery provider and limits repeated requests', async () => {
    const repository = new MemoryDigestRecipientRepository();
    const queue = new RecordingVerificationQueue();
    const unconfigured = new DigestRecipientService(
      repository, queue, 'https://app.example.com', false,
    );
    await expect(unconfigured.request('user-a', 'student@example.com', 'client-a'))
      .rejects.toMatchObject({ code: 'DIGEST_DELIVERY_NOT_CONFIGURED', status: 503 });

    const configured = new DigestRecipientService(
      repository, queue, 'https://app.example.com', true,
      new MemoryDigestRecipientRateLimiter(),
      () => new Date('2026-08-12T08:00:00.000Z'),
    );
    for (let index = 0; index < 5; index += 1) {
      await configured.request('user-a', 'student@example.com', 'client-a');
    }
    await expect(configured.request('user-a', 'student@example.com', 'client-a'))
      .rejects.toMatchObject({ code: 'DIGEST_EMAIL_RATE_LIMITED', status: 429 });
    expect(queue.jobs).toHaveLength(5);
  });

  it('does not enqueue when persistence fails', async () => {
    const queue = new RecordingVerificationQueue();
    const service = new DigestRecipientService({
      get: vi.fn(),
      begin: vi.fn().mockRejectedValue(new Error('database unavailable')),
      confirm: vi.fn(),
    }, queue, 'https://app.example.com', true);

    await expect(service.request('user-a', 'student@example.com', 'client-a')).rejects.toThrow();
    expect(queue.jobs).toHaveLength(0);
  });
});
