import { createEmailUnsubscribeToken, createEmailUnsubscribeTokenId } from '@lettermate/domain/email-unsubscribe';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  DigestUnsubscribeService,
  MemoryDigestUnsubscribeRepository,
  PrismaDigestUnsubscribeRepository,
} from './digest-unsubscribe-service.js';

const secret = 'unsubscribe-secret-with-at-least-thirty-two-characters';

describe('digest unsubscribe service', () => {
  it('is idempotent for the current token and rejects revoked tokens', async () => {
    const repository = new MemoryDigestUnsubscribeRepository();
    const service = new DigestUnsubscribeService(repository, secret);
    const currentId = createEmailUnsubscribeTokenId();
    repository.register('user-a', currentId);
    const current = createEmailUnsubscribeToken(currentId, secret);

    await expect(service.unsubscribe(current)).resolves.toEqual({ status: 'unsubscribed' });
    await expect(service.unsubscribe(current)).resolves.toEqual({ status: 'unsubscribed' });

    repository.register('user-a', createEmailUnsubscribeTokenId());
    await expect(service.unsubscribe(current)).rejects.toMatchObject({
      code: 'DIGEST_UNSUBSCRIBE_INVALID', status: 400,
    });
  });

  it('uses one conditional database update for repeated or concurrent requests', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repository = new PrismaDigestUnsubscribeRepository({
      digestPreference: { updateMany },
    } as unknown as PrismaClient);
    const tokenId = createEmailUnsubscribeTokenId();

    await expect(Promise.all([
      repository.unsubscribe(tokenId),
      repository.unsubscribe(tokenId),
    ])).resolves.toEqual([true, true]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { unsubscribeTokenId: tokenId }, data: { enabled: false },
    });
  });

  it('rejects a tampered signature before touching persistence', async () => {
    const repository = { unsubscribe: vi.fn() };
    const service = new DigestUnsubscribeService(repository, secret);
    const token = createEmailUnsubscribeToken(createEmailUnsubscribeTokenId(), secret);

    await expect(service.unsubscribe(`${token.slice(0, -1)}x`)).rejects.toMatchObject({
      code: 'DIGEST_UNSUBSCRIBE_INVALID', status: 400,
    });
    expect(repository.unsubscribe).not.toHaveBeenCalled();
  });
});
