import { describe, expect, it, vi } from 'vitest';
import {
  FakeEmailGateway,
  SmtpEmailGateway,
  renderDigestEmail,
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
});
