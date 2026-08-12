import { describe, expect, it } from 'vitest';
import {
  createEmailUnsubscribeToken,
  createEmailUnsubscribeTokenId,
  emailUnsubscribeUrl,
  verifyEmailUnsubscribeToken,
} from './email-unsubscribe.js';

const secret = 'unsubscribe-secret-with-at-least-thirty-two-characters';

describe('email unsubscribe tokens', () => {
  it('signs an opaque token id without embedding account data', () => {
    const tokenId = createEmailUnsubscribeTokenId();
    const token = createEmailUnsubscribeToken(tokenId, secret);

    expect(verifyEmailUnsubscribeToken(token, secret)).toEqual({ tokenId });
    expect(token).not.toContain('user-a');
    expect(token).not.toContain('@');
  });

  it('rejects tampering, another secret, and malformed tokens', () => {
    const token = createEmailUnsubscribeToken(createEmailUnsubscribeTokenId(), secret);

    expect(verifyEmailUnsubscribeToken(`${token.slice(0, -1)}x`, secret)).toBeNull();
    expect(verifyEmailUnsubscribeToken(token, 'another-secret-with-at-least-thirty-two-characters'))
      .toBeNull();
    expect(verifyEmailUnsubscribeToken('v1.user-a.signature', secret)).toBeNull();
  });

  it('builds an encoded public URL', () => {
    const tokenId = createEmailUnsubscribeTokenId();
    const url = emailUnsubscribeUrl('https://app.example.com', '/digest/unsubscribe', tokenId, secret);

    expect(url).toMatch(/^https:\/\/app\.example\.com\/digest\/unsubscribe\?token=/);
    expect(verifyEmailUnsubscribeToken(new URL(url).searchParams.get('token')!, secret))
      .toEqual({ tokenId });
  });
});
