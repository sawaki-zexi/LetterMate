import { describe, expect, it, vi } from 'vitest';
import {
  FakeEmailGateway,
  ResendEmailGateway,
  SmtpEmailGateway,
  renderDigestEmail,
  renderDigestVerificationEmail,
} from './digest-email.js';
import type { EmailGatewayError } from './digest-email.js';

describe('digest email gateway', () => {
  it('renders persisted snapshots and records delivery without external configuration', async () => {
    const gateway = new FakeEmailGateway();
    const message = renderDigestEmail({
      recipient: 'student@example.com',
      scheduledLocalDate: '2026-08-08',
      items: [{
        title: 'GPT model update <official>',
        summary: '已经持久化的中文摘要。',
        reason: '与关注的模型版本直接相关。',
        sourceUrl: 'https://example.com/model-update',
      }],
    });

    const result = await gateway.send(message, { idempotencyKey: 'digest:run-1' });

    expect(result).toEqual({ messageId: 'fake-1' });
    expect(gateway.messages).toHaveLength(1);
    expect(gateway.messages[0]).toMatchObject({
      to: 'student@example.com',
      subject: 'LetterMate 每日研究简报 | 2026-08-08',
    });
    expect(gateway.messages[0]?.text).toContain('引用：https://example.com/model-update');
    expect(gateway.messages[0]?.text).toContain('不确定性：');
    expect(gateway.messages[0]?.html).toContain('GPT model update &lt;official&gt;');
  });

  it('escapes the verification link and includes a readable text fallback', () => {
    const message = renderDigestVerificationEmail({
      recipient: 'student@example.com',
      verificationUrl: 'https://app.example.com/digest/verify?token=a&next=<unsafe>',
      expiresAt: '2026-08-13T08:00:00.000Z',
    });

    expect(message.text).toContain('token=a&next=<unsafe>');
    expect(message.html).toContain('token=a&amp;next=&lt;unsafe&gt;');
    expect(message.html).not.toContain('next=<unsafe>');
  });

  it('renders visible unsubscribe links and standards-compatible one-click headers', () => {
    const message = renderDigestEmail({
      recipient: 'student@example.com',
      scheduledLocalDate: '2026-08-08',
      items: [],
      unsubscribeUrl: 'https://app.example.com/digest/unsubscribe?token=browser-token',
      oneClickUnsubscribeUrl: 'https://app.example.com/api/v1/digest/unsubscribe?token=post-token',
    });

    expect(message.text).toContain('https://app.example.com/digest/unsubscribe?token=browser-token');
    expect(message.html).toContain('https://app.example.com/digest/unsubscribe?token=browser-token');
    expect(message.headers).toEqual({
      'List-Unsubscribe': '<https://app.example.com/api/v1/digest/unsubscribe?token=post-token>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('deduplicates an accepted delivery when its first confirmation is lost', async () => {
    const gateway = new FakeEmailGateway([{
      type: 'accept_then_lose_confirmation',
      code: 'EMAIL_CONFIRMATION_LOST',
    }]);
    const message = renderDigestEmail({
      recipient: 'student@example.com',
      scheduledLocalDate: '2026-08-08',
      items: [{
        title: '模型更新', summary: '摘要', reason: '理由',
        sourceUrl: 'https://example.com/update',
      }],
    });

    await expect(gateway.send(message, { idempotencyKey: 'digest:run-1' }))
      .rejects.toMatchObject({
        code: 'EMAIL_CONFIRMATION_LOST', retryable: true,
      });
    await expect(gateway.send(message, { idempotencyKey: 'digest:run-1' }))
      .resolves.toEqual({ messageId: 'fake-1' });
    expect(gateway.messages).toHaveLength(1);
    expect(gateway.attempts).toHaveLength(2);
  });

  it('does not accept a message that fails before delivery', async () => {
    const gateway = new FakeEmailGateway([{
      type: 'fail_before_accept', code: 'EMAIL_RATE_LIMITED',
      retryable: true, retryAfterMs: 30_000,
    }]);
    const message = renderDigestEmail({
      recipient: 'student@example.com', scheduledLocalDate: '2026-08-08', items: [],
    });

    await expect(gateway.send(message, { idempotencyKey: 'digest:run-1' }))
      .rejects.toMatchObject({
        code: 'EMAIL_RATE_LIMITED', retryable: true, retryAfterMs: 30_000,
      });
    expect(gateway.messages).toHaveLength(0);
  });

  it('uses a deterministic SMTP Message-ID without exposing transport details', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<provider@example.com>', rejected: [] });
    const gateway = new SmtpEmailGateway({ sendMail }, {
      from: 'LetterMate <digest@example.com>', messageIdDomain: 'mail.example.com',
    });
    const message = renderDigestEmail({
      recipient: 'student@example.com', scheduledLocalDate: '2026-08-08', items: [],
    });

    await expect(gateway.send(message, { idempotencyKey: 'digest:run-1' }))
      .resolves.toEqual({ messageId: '<provider@example.com>' });
    const firstMessageId = sendMail.mock.calls[0]?.[0].messageId;
    await gateway.send(message, { idempotencyKey: 'digest:run-1' });
    expect(sendMail.mock.calls[1]?.[0].messageId).toBe(firstMessageId);
    expect(firstMessageId).toMatch(/^<[a-f0-9]{64}@mail\.example\.com>$/);
  });

  it('classifies SMTP failures into safe retry behavior', async () => {
    const gateway = new SmtpEmailGateway({
      sendMail: vi.fn().mockRejectedValue(Object.assign(new Error('secret provider response'), {
        code: 'EAUTH', response: '535 password rejected',
      })),
    }, { from: 'digest@example.com', messageIdDomain: 'mail.example.com' });

    await expect(gateway.send({
      to: 'student@example.com', subject: 'Digest', text: 'text', html: '<p>text</p>',
    }, { idempotencyKey: 'digest:run-1' })).rejects.toEqual(expect.objectContaining({
      code: 'EMAIL_AUTHENTICATION_FAILED', retryable: false,
      message: 'Email delivery failed',
    } satisfies Partial<EmailGatewayError>));
  });

  it('sends Resend requests with a provider idempotency key', async () => {
    const http = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'email-123' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const gateway = new ResendEmailGateway(http, {
      apiKey: 're_secret',
      baseUrl: 'https://api.resend.com',
      from: 'LetterMate <digest@mail.example.com>',
      timeoutMs: 10_000,
    });

    await expect(gateway.send({
      to: 'student@example.com', subject: 'Digest', text: 'text', html: '<p>text</p>',
    }, { idempotencyKey: 'digest:run-1' })).resolves.toEqual({ messageId: 'email-123' });

    expect(http).toHaveBeenCalledOnce();
    const [url, init] = http.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer re_secret');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('digest:run-1');
    expect(JSON.parse(String(init.body))).toEqual({
      from: 'LetterMate <digest@mail.example.com>',
      to: ['student@example.com'],
      subject: 'Digest',
      text: 'text',
      html: '<p>text</p>',
    });
  });

  it('forwards allowlisted unsubscribe headers through Resend and SMTP', async () => {
    const headers = {
      'List-Unsubscribe': '<https://app.example.com/api/v1/digest/unsubscribe?token=signed>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' as const,
    };
    const http = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'email-123' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const resend = new ResendEmailGateway(http, {
      apiKey: 're_secret', baseUrl: 'https://api.resend.com',
      from: 'digest@example.com', timeoutMs: 10_000,
    });
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'smtp-123', rejected: [] });
    const smtp = new SmtpEmailGateway({ sendMail }, {
      from: 'digest@example.com', messageIdDomain: 'mail.example.com',
    });
    const message = {
      to: 'student@example.com', subject: 'Digest', text: 'text', html: '<p>text</p>', headers,
    };

    await resend.send(message, { idempotencyKey: 'digest:run-headers' });
    await smtp.send(message, { idempotencyKey: 'digest:run-headers' });

    expect(JSON.parse(String((http.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ headers });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ headers }));
  });

  it.each([
    [401, 'EMAIL_AUTHENTICATION_FAILED', false],
    [409, 'EMAIL_IDEMPOTENCY_CONFLICT', false],
    [429, 'EMAIL_RATE_LIMITED', true],
    [503, 'EMAIL_PROVIDER_UNAVAILABLE', true],
    [422, 'EMAIL_GATEWAY_UNAVAILABLE', false],
  ] as const)('classifies Resend status %s safely', async (status, code, retryable) => {
    const gateway = new ResendEmailGateway(vi.fn().mockResolvedValue(new Response('{}', {
      status,
      headers: status === 429 ? { 'retry-after': '30' } : {},
    })), {
      apiKey: 're_secret', baseUrl: 'https://api.resend.com',
      from: 'digest@example.com', timeoutMs: 10_000,
    });

    await expect(gateway.send({
      to: 'student@example.com', subject: 'Digest', text: 'text', html: '<p>text</p>',
    }, { idempotencyKey: 'digest:run-1' })).rejects.toEqual(expect.objectContaining({
      code, retryable,
      ...(status === 429 ? { retryAfterMs: 30_000 } : {}),
      message: 'Email delivery failed',
    } satisfies Partial<EmailGatewayError>));
  });

  it('treats an invalid successful Resend response as an ambiguous confirmation', async () => {
    const gateway = new ResendEmailGateway(vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
    })), {
      apiKey: 're_secret', baseUrl: 'https://api.resend.com',
      from: 'digest@example.com', timeoutMs: 10_000,
    });

    await expect(gateway.send({
      to: 'student@example.com', subject: 'Digest', text: 'text', html: '<p>text</p>',
    }, { idempotencyKey: 'digest:run-1' })).rejects.toMatchObject({
      code: 'EMAIL_CONFIRMATION_LOST', retryable: true,
    });
  });
});
