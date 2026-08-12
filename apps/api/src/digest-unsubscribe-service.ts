import { digestUnsubscribeResultSchema, type DigestUnsubscribeResult } from '@lettermate/contracts';
import { verifyEmailUnsubscribeToken } from '@lettermate/domain/email-unsubscribe';
import type { PrismaClient } from '@prisma/client';

export class DigestUnsubscribeError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super('Digest unsubscribe operation failed');
    this.name = 'DigestUnsubscribeError';
  }
}

export interface DigestUnsubscribeRepository {
  unsubscribe(tokenId: string): Promise<boolean>;
}

export class MemoryDigestUnsubscribeRepository implements DigestUnsubscribeRepository {
  private readonly tokenOwners = new Map<string, string>();

  register(userId: string, tokenId: string): void {
    for (const [currentTokenId, owner] of this.tokenOwners) {
      if (owner === userId) this.tokenOwners.delete(currentTokenId);
    }
    this.tokenOwners.set(tokenId, userId);
  }

  async unsubscribe(tokenId: string): Promise<boolean> {
    return this.tokenOwners.has(tokenId);
  }
}

export class PrismaDigestUnsubscribeRepository implements DigestUnsubscribeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async unsubscribe(tokenId: string): Promise<boolean> {
    const result = await this.prisma.digestPreference.updateMany({
      where: { unsubscribeTokenId: tokenId },
      data: { enabled: false },
    });
    return result.count === 1;
  }
}

export class DigestUnsubscribeService {
  constructor(
    private readonly repository: DigestUnsubscribeRepository,
    private readonly secret: string,
  ) {}

  async unsubscribe(token: string): Promise<DigestUnsubscribeResult> {
    const verified = verifyEmailUnsubscribeToken(token, this.secret);
    if (!verified || !await this.repository.unsubscribe(verified.tokenId)) {
      throw new DigestUnsubscribeError('DIGEST_UNSUBSCRIBE_INVALID', 400);
    }
    return digestUnsubscribeResultSchema.parse({ status: 'unsubscribed' });
  }
}
