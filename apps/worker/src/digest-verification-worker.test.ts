import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { FakeEmailGateway } from './digest-email.js';
import {
  createDigestVerificationJobHandler,
  DigestVerificationDeliveryService,
  PrismaDigestVerificationDeliveryRepository,
} from './digest-verification-worker.js';

describe('digest verification worker', () => {
  it('renders and sends one verification message with a stable idempotency key', async () => {
    const gateway = new FakeEmailGateway();
    const service = new DigestVerificationDeliveryService(gateway);

    await service.run({
      verificationId: 'verification-1',
      recipient: 'student@example.com',
      verificationUrl: 'https://app.example.com/digest/verify?token=secret-token',
      expiresAt: '2026-08-13T08:00:00.000Z',
    });

    expect(gateway.attempts).toHaveLength(1);
    expect(gateway.attempts[0]).toMatchObject({
      idempotencyKey: 'digest-verification:verification-1',
      message: {
        to: 'student@example.com',
        subject: '确认接收 LetterMate 每日研究简报',
      },
    });
    expect(gateway.messages[0]?.text).toContain('https://app.example.com/digest/verify?token=secret-token');
    expect(gateway.messages[0]?.html).toContain('确认收件邮箱');
  });

  it('validates queue data before delivery', async () => {
    const service = { run: vi.fn() };
    const handler = createDigestVerificationJobHandler(service);

    await expect(handler({ data: {
      verificationId: '', recipient: 'invalid', verificationUrl: 'javascript:alert(1)',
      expiresAt: 'invalid',
    } } as never)).rejects.toThrow();
    expect(service.run).not.toHaveBeenCalled();
  });

  it('persists the provider message ID after successful delivery', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      digestEmailVerification: {
        updateMany: async (input: Record<string, unknown>) => {
          updates.push(input);
          return { count: 1 };
        },
        findUnique: async () => null,
      },
    } as unknown as PrismaClient;
    const gateway = new FakeEmailGateway();
    const service = new DigestVerificationDeliveryService(
      gateway,
      new PrismaDigestVerificationDeliveryRepository(prisma),
    );

    await service.run({
      verificationId: 'verification-1',
      recipient: 'student@example.com',
      verificationUrl: 'https://app.example.com/digest/verify?token=secret-token',
      expiresAt: '2026-08-13T08:00:00.000Z',
    });

    expect(updates).toEqual([{
      where: { id: 'verification-1', providerMessageId: null },
      data: { providerMessageId: 'fake-1' },
    }]);
  });
});
