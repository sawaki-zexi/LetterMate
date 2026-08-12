import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 'v1';
const TOKEN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const createEmailUnsubscribeTokenId = (): string => randomUUID();

const signatureFor = (tokenId: string, secret: string): Buffer => createHmac('sha256', secret)
  .update(`${TOKEN_VERSION}.${tokenId}`)
  .digest();

export const createEmailUnsubscribeToken = (tokenId: string, secret: string): string => {
  if (!TOKEN_ID_PATTERN.test(tokenId)) throw new Error('Invalid email unsubscribe token id');
  return `${TOKEN_VERSION}.${tokenId}.${signatureFor(tokenId, secret).toString('base64url')}`;
};

export const verifyEmailUnsubscribeToken = (
  token: string,
  secret: string,
): { tokenId: string } | null => {
  const [version, tokenId, signature, extra] = token.split('.');
  if (extra !== undefined || version !== TOKEN_VERSION || !tokenId || !signature) return null;
  if (!TOKEN_ID_PATTERN.test(tokenId)) return null;
  const actual = Buffer.from(signature, 'base64url');
  if (actual.toString('base64url') !== signature) return null;
  const expected = signatureFor(tokenId, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { tokenId };
};

export const emailUnsubscribeUrl = (
  origin: string,
  path: string,
  tokenId: string,
  secret: string,
): string => {
  const url = new URL(path, origin);
  url.searchParams.set('token', createEmailUnsubscribeToken(tokenId, secret));
  return url.toString();
};
