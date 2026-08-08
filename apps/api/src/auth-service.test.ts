import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthService,
  MemoryAuthRateLimiter,
  MemoryAuthStore,
  clearAuthCookies,
  parseCookies,
  setAuthCookies,
} from './auth-service.js';
import type { Response } from 'express';

describe('authentication service', () => {
  it('registers, logs in, authenticates, validates CSRF, and revokes sessions', async () => {
    const store = new MemoryAuthStore();
    const auth = new AuthService(
      store,
      'session-secret-with-at-least-32-characters',
      'csrf-secret-with-at-least-32-characters',
      () => new Date('2026-08-08T00:00:00.000Z'),
    );

    const registered = await auth.register({
      email: ' Student@Example.com ',
      password: 'correct horse battery staple',
      timezone: 'Asia/Shanghai',
    });
    expect(registered.session.user).toMatchObject({ email: 'student@example.com' });
    expect(registered.token).not.toContain('student@example.com');
    expect(auth.verifyCsrfToken(
      registered.sessionId,
      registered.session.csrfToken ?? undefined,
    )).toBe(true);
    expect(auth.verifyCsrfToken(registered.sessionId, 'invalid.token')).toBe(false);

    await expect(auth.login('student@example.com', 'wrong password'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    await expect(auth.register({
      email: 'student@example.com', password: 'another secure password', timezone: 'UTC',
    })).rejects.toMatchObject({ code: 'AUTH_EMAIL_TAKEN', status: 409 });

    const loggedIn = await auth.login('student@example.com', 'correct horse battery staple');
    await expect(auth.authenticate(loggedIn.token)).resolves.toMatchObject({
      session: { authenticated: true, user: { email: 'student@example.com' } },
    });
    await auth.logout(loggedIn.token);
    await expect(auth.authenticate(loggedIn.token)).resolves.toBeNull();
  });

  it('limits repeated login failures without locking out a different client', async () => {
    const auth = new AuthService(
      new MemoryAuthStore(),
      'session-secret-with-at-least-32-characters',
      'csrf-secret-with-at-least-32-characters',
      () => new Date('2026-08-08T00:00:00.000Z'),
      new MemoryAuthRateLimiter(2, 60_000),
    );
    await auth.register({
      email: 'student@example.com',
      password: 'correct horse battery staple',
      timezone: 'Asia/Shanghai',
    });

    await expect(auth.login('student@example.com', 'wrong password', 'client-a'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(auth.login('student@example.com', 'wrong password', 'client-a'))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(auth.login('student@example.com', 'correct horse battery staple', 'client-a'))
      .rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED', status: 429 });
    await expect(auth.login('student@example.com', 'correct horse battery staple', 'client-b'))
      .resolves.toMatchObject({ session: { authenticated: true } });
  });

  it('renews near-expiry sessions and upgrades an older scrypt password hash', async () => {
    const store = new MemoryAuthStore();
    let now = new Date('2026-08-08T00:00:00.000Z');
    const password = 'correct horse battery staple';
    const salt = Buffer.alloc(16, 7);
    const legacyHash = scryptSync(password, salt, 32, { N: 4_096, r: 8, p: 1 });
    await store.createUser({
      id: 'legacy-user',
      email: 'legacy@example.com',
      timezone: 'Asia/Shanghai',
      passwordHash: `scrypt$4096$8$1$${salt.toString('base64url')}$${legacyHash.toString('base64url')}`,
    });
    const auth = new AuthService(
      store,
      'session-secret-with-at-least-32-characters',
      'csrf-secret-with-at-least-32-characters',
      () => now,
    );

    const loggedIn = await auth.login('legacy@example.com', password);
    expect(store.users.get('legacy-user')?.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    now = new Date('2026-09-02T00:00:00.000Z');
    await expect(auth.authenticate(loggedIn.token)).resolves.toMatchObject({ renewed: true });
    expect([...store.sessions.values()][0]?.expiresAt.toISOString())
      .toBe('2026-10-02T00:00:00.000Z');
  });

  it('serializes secure session cookies without leaking the raw token', () => {
    const headers = new Map<string, unknown>();
    const response = {
      setHeader: (name: string, value: unknown) => headers.set(name, value),
    } as unknown as Response;
    setAuthCookies(response, 'session-secret', 'csrf-token-value', true);
    const cookies = headers.get('Set-Cookie') as string[];

    expect(cookies[0]).toMatch(/lettermate_session=.*HttpOnly.*Secure/);
    expect(cookies[1]).toMatch(/lettermate_csrf=.*Secure/);
    expect(cookies[1]).not.toContain('HttpOnly');
    expect(parseCookies('a=1; lettermate_session=session-secret')).toMatchObject({
      lettermate_session: 'session-secret',
    });

    clearAuthCookies(response, true);
    expect(headers.get('Set-Cookie')).toEqual(expect.arrayContaining([
      expect.stringContaining('Max-Age=0'),
    ]));
  });
});
