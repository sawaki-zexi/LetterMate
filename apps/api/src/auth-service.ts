import type { AuthRegisterInput, AuthSession, AuthUser } from '@lettermate/contracts';
import type { PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { currentTraceId } from './observability.js';

const SESSION_COOKIE = 'lettermate_session';
const CSRF_COOKIE = 'lettermate_csrf';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_RENEWAL_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1_000;
const SCRYPT_PARAMETERS = { N: 16_384, r: 8, p: 1, length: 64, saltLength: 16 } as const;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const LOGIN_MAX_FAILURES = 10;

export class AuthError extends Error {
  constructor(
    public readonly code: 'AUTH_EMAIL_TAKEN' | 'INVALID_CREDENTIALS' | 'AUTH_RATE_LIMITED',
    public readonly status: 401 | 409 | 429,
  ) {
    super(code === 'AUTH_EMAIL_TAKEN'
      ? '邮箱已注册'
      : code === 'AUTH_RATE_LIMITED'
        ? '登录尝试过多，请稍后重试'
        : '邮箱或密码错误');
    this.name = 'AuthError';
  }
}

interface StoredUser {
  id: string;
  email: string;
  timezone: string;
  passwordHash: string;
}

interface StoredSession {
  id: string;
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface AuthStore {
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;
  createUser(input: StoredUser): Promise<StoredUser>;
  createSession(session: StoredSession): Promise<void>;
  findSession(tokenHash: string, now: Date): Promise<(StoredSession & { user: StoredUser }) | null>;
  revokeSession(tokenHash: string): Promise<void>;
  extendSession(tokenHash: string, expiresAt: Date): Promise<void>;
  updatePasswordHash(userId: string, expectedHash: string, passwordHash: string): Promise<void>;
}

export interface AuthRateLimiter {
  assertAllowed(key: string, now: Date): void;
  recordFailure(key: string, now: Date): void;
  clear(key: string): void;
}

interface LoginAttempt {
  failures: number;
  windowStartedAt: number;
}

export class MemoryAuthRateLimiter implements AuthRateLimiter {
  private readonly attempts = new Map<string, LoginAttempt>();

  constructor(
    private readonly maxFailures = LOGIN_MAX_FAILURES,
    private readonly windowMs = LOGIN_WINDOW_MS,
  ) {}

  assertAllowed(key: string, now: Date): void {
    const attempt = this.current(key, now);
    if (attempt && attempt.failures >= this.maxFailures) {
      throw new AuthError('AUTH_RATE_LIMITED', 429);
    }
  }

  recordFailure(key: string, now: Date): void {
    const attempt = this.current(key, now);
    this.attempts.set(key, attempt
      ? { ...attempt, failures: attempt.failures + 1 }
      : { failures: 1, windowStartedAt: now.getTime() });
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  private current(key: string, now: Date): LoginAttempt | null {
    const attempt = this.attempts.get(key);
    if (!attempt) return null;
    if (now.getTime() - attempt.windowStartedAt >= this.windowMs) {
      this.attempts.delete(key);
      return null;
    }
    return attempt;
  }
}

const toUser = (user: StoredUser): AuthUser => ({
  id: user.id,
  email: user.email,
  timezone: user.timezone,
});

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const deriveKey = (
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> => new Promise((resolve, reject) => {
  nodeScrypt(password, salt, length, options, (error, key) => {
    if (error) reject(error);
    else resolve(key);
  });
});

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_PARAMETERS.saltLength);
  const derived = await deriveKey(password, salt, SCRYPT_PARAMETERS.length, SCRYPT_PARAMETERS);
  return `scrypt$${SCRYPT_PARAMETERS.N}$${SCRYPT_PARAMETERS.r}$${SCRYPT_PARAMETERS.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(
  password: string,
  encoded: string,
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  const [algorithm, n, r, p, saltEncoded, hashEncoded] = encoded.split('$');
  if (algorithm !== 'scrypt' || !n || !r || !p || !saltEncoded || !hashEncoded) {
    return { valid: false, needsUpgrade: false };
  }
  try {
    const parsed = { N: Number(n), r: Number(r), p: Number(p) };
    const expected = Buffer.from(hashEncoded, 'base64url');
    const salt = Buffer.from(saltEncoded, 'base64url');
    const actual = await deriveKey(
      password,
      salt,
      expected.length,
      parsed,
    );
    const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
    return {
      valid,
      needsUpgrade: valid && (
        parsed.N !== SCRYPT_PARAMETERS.N
        || parsed.r !== SCRYPT_PARAMETERS.r
        || parsed.p !== SCRYPT_PARAMETERS.p
        || expected.length !== SCRYPT_PARAMETERS.length
        || salt.length < SCRYPT_PARAMETERS.saltLength
      ),
    };
  } catch {
    return { valid: false, needsUpgrade: false };
  }
}

const opaqueKey = (value: string): string => createHash('sha256').update(value).digest('hex');

export class MemoryAuthStore implements AuthStore {
  readonly users = new Map<string, StoredUser>();
  readonly sessions = new Map<string, StoredSession>();

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }

  async findUserById(id: string): Promise<StoredUser | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(input: StoredUser): Promise<StoredUser> {
    if (this.users.has(input.id) || [...this.users.values()].some((user) => user.email === input.email)) {
      throw new AuthError('AUTH_EMAIL_TAKEN', 409);
    }
    this.users.set(input.id, input);
    return input;
  }

  async createSession(session: StoredSession): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }

  async findSession(token: string, now: Date): Promise<(StoredSession & { user: StoredUser }) | null> {
    const session = this.sessions.get(token);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    const user = this.users.get(session.userId);
    return user ? { ...session, user } : null;
  }

  async revokeSession(token: string): Promise<void> {
    const session = this.sessions.get(token);
    if (session) this.sessions.set(token, { ...session, revokedAt: new Date() });
  }

  async extendSession(token: string, expiresAt: Date): Promise<void> {
    const session = this.sessions.get(token);
    if (session && !session.revokedAt) this.sessions.set(token, { ...session, expiresAt });
  }

  async updatePasswordHash(userId: string, expectedHash: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId);
    if (user?.passwordHash === expectedHash) this.users.set(userId, { ...user, passwordHash });
  }
}

export class PrismaAuthStore implements AuthStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, timezone: true, passwordHash: true },
    });
  }

  async findUserById(id: string): Promise<StoredUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, timezone: true, passwordHash: true },
    });
  }

  async createUser(input: StoredUser): Promise<StoredUser> {
    try {
      return await this.prisma.user.create({
        data: input,
        select: { id: true, email: true, timezone: true, passwordHash: true },
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new AuthError('AUTH_EMAIL_TAKEN', 409);
      }
      throw error;
    }
  }

  async createSession(session: StoredSession): Promise<void> {
    await this.prisma.session.create({ data: session });
  }

  async findSession(token: string, now: Date): Promise<(StoredSession & { user: StoredUser }) | null> {
    const session = await this.prisma.session.findFirst({
      where: { tokenHash: token, revokedAt: null, expiresAt: { gt: now } },
      include: { user: { select: { id: true, email: true, timezone: true, passwordHash: true } } },
    });
    return session;
  }

  async revokeSession(token: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { tokenHash: token, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async extendSession(token: string, expiresAt: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { tokenHash: token, revokedAt: null },
      data: { expiresAt },
    });
  }

  async updatePasswordHash(userId: string, expectedHash: string, passwordHash: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, passwordHash: expectedHash },
      data: { passwordHash },
    });
  }
}

export interface AuthSessionResult {
  token: string;
  sessionId: string;
  session: AuthSession;
  renewed: boolean;
}

export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly sessionSecret: string,
    private readonly csrfSecret: string,
    private readonly now: () => Date = () => new Date(),
    private readonly rateLimiter: AuthRateLimiter = new MemoryAuthRateLimiter(),
  ) {}

  async register(input: AuthRegisterInput): Promise<AuthSessionResult> {
    const email = normalizeEmail(input.email);
    const existing = await this.store.findUserByEmail(email);
    if (existing) throw new AuthError('AUTH_EMAIL_TAKEN', 409);
    const user = await this.store.createUser({
      id: randomUUID(),
      email,
      timezone: input.timezone,
      passwordHash: await hashPassword(input.password),
    });
    return this.issueSession(user);
  }

  async login(emailInput: string, password: string, clientKey = 'unknown'): Promise<AuthSessionResult> {
    const now = this.now();
    const email = normalizeEmail(emailInput);
    const attemptKey = opaqueKey(`${clientKey}\u0000${email}`);
    this.rateLimiter.assertAllowed(attemptKey, now);
    const user = await this.store.findUserByEmail(email);
    const passwordResult = user
      ? await verifyPassword(password, user.passwordHash)
      : { valid: false, needsUpgrade: false };
    if (!user || !passwordResult.valid) {
      this.rateLimiter.recordFailure(attemptKey, now);
      throw new AuthError('INVALID_CREDENTIALS', 401);
    }
    this.rateLimiter.clear(attemptKey);
    if (passwordResult.needsUpgrade) {
      await this.store.updatePasswordHash(
        user.id,
        user.passwordHash,
        await hashPassword(password),
      );
    }
    return this.issueSession(user);
  }

  async authenticate(token: string | undefined): Promise<AuthSessionResult | null> {
    if (!token) return null;
    const now = this.now();
    const hashedToken = this.tokenHash(token);
    const session = await this.store.findSession(hashedToken, now);
    if (!session) return null;
    const renewed = session.expiresAt.getTime() - now.getTime() <= SESSION_RENEWAL_THRESHOLD_MS;
    if (renewed) {
      await this.store.extendSession(hashedToken, new Date(now.getTime() + SESSION_TTL_MS));
    }
    const csrfToken = this.createCsrfToken(session.id);
    return {
      token,
      sessionId: session.id,
      session: { authenticated: true, user: toUser(session.user), csrfToken },
      renewed,
    };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.store.revokeSession(this.tokenHash(token));
  }

  createCsrfToken(sessionId: string): string {
    const nonce = randomBytes(18).toString('base64url');
    const signature = createHmac('sha256', this.csrfSecret)
      .update(`${sessionId}.${nonce}`)
      .digest('base64url');
    return `${nonce}.${signature}`;
  }

  verifyCsrfToken(sessionId: string, value: string | undefined): boolean {
    if (!value) return false;
    const [nonce, signature] = value.split('.');
    if (!nonce || !signature) return false;
    const expected = createHmac('sha256', this.csrfSecret)
      .update(`${sessionId}.${nonce}`)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async issueSession(user: StoredUser): Promise<AuthSessionResult> {
    const token = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    await this.store.createSession({
      id: sessionId,
      tokenHash: this.tokenHash(token),
      userId: user.id,
      expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS),
      revokedAt: null,
    });
    return {
      token,
      sessionId,
      session: {
        authenticated: true,
        user: toUser(user),
        csrfToken: this.createCsrfToken(sessionId),
      },
      renewed: false,
    };
  }

  private tokenHash(token: string): string {
    return createHmac('sha256', this.sessionSecret).update(token).digest('hex');
  }
}

export const parseCookies = (header: string | undefined): Record<string, string> => (
  Object.fromEntries((header ?? '').split(';').flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [];
    const key = part.slice(0, index).trim();
    try {
      return key ? [[key, decodeURIComponent(part.slice(index + 1).trim())]] : [];
    } catch {
      return [];
    }
  }))
);

const cookie = (
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
  httpOnly: boolean,
): string => [
  `${name}=${encodeURIComponent(value)}`,
  'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`,
  ...(httpOnly ? ['HttpOnly'] : []),
  ...(secure ? ['Secure'] : []),
].join('; ');

export const setAuthCookies = (response: Response, token: string, csrfToken: string, secure: boolean): void => {
  response.setHeader('Set-Cookie', [
    cookie(SESSION_COOKIE, token, secure, SESSION_TTL_MS / 1_000, true),
    cookie(CSRF_COOKIE, csrfToken, secure, SESSION_TTL_MS / 1_000, false),
  ]);
};

export const clearAuthCookies = (response: Response, secure: boolean): void => {
  response.setHeader('Set-Cookie', [
    cookie(SESSION_COOKIE, '', secure, 0, true),
    cookie(CSRF_COOKIE, '', secure, 0, false),
  ]);
};

export function createAuthMiddleware(
  auth: AuthService,
  options: { allowDevIdentity: boolean; secureCookies: boolean },
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    if (options.allowDevIdentity) {
      next();
      return;
    }
    delete request.headers['x-user-id'];
    delete request.headers['x-user-email'];
    delete request.headers['x-user-timezone'];
    delete request.headers['x-auth-csrf'];
    const cookies = parseCookies(request.headers.cookie);
    void auth.authenticate(cookies[SESSION_COOKIE]).then((session) => {
      if (session) {
        if (session.renewed && session.session.csrfToken) {
          setAuthCookies(response, session.token, session.session.csrfToken, options.secureCookies);
        }
        request.headers['x-user-id'] = session.session.user?.id;
        request.headers['x-user-email'] = session.session.user?.email;
        request.headers['x-user-timezone'] = session.session.user?.timezone;
        request.headers['x-auth-csrf'] = session.session.csrfToken ?? undefined;
        const method = request.method.toUpperCase();
        const authPublic = /^\/api\/v1\/auth\/(login|register|session)$/.test(request.path)
          || request.path === '/api/v1/digest/unsubscribe'
          || request.path === '/api/v1/email-webhooks/resend';
        if (!authPublic && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          const csrfHeader = request.headers['x-csrf-token'] as string | undefined;
          if (!auth.verifyCsrfToken(session.sessionId, csrfHeader)) {
            response.status(403).json({ code: 'CSRF_INVALID', message: '请求校验失败', traceId: currentTraceId() });
            return;
          }
        }
      }
      next();
    }).catch(() => next());
  };
}

export const authCookieNames = { session: SESSION_COOKIE, csrf: CSRF_COOKIE } as const;
