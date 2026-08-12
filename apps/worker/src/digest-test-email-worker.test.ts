import { describe, expect, it, vi } from 'vitest';
import { EmailGatewayError, FakeEmailGateway, renderDigestTestEmail } from './digest-email.js';
import {
  createDigestTestEmailJobHandler,
  DigestTestEmailDeliveryService,
  type DigestTestEmailDeliveryRepository,
} from './digest-test-email-worker.js';

const claimed = {
  id: 'test-1', userId: 'user-a', recipient: 'verified@example.com',
  leaseUntil: new Date('2026-08-12T08:10:00.000Z'),
};

const repository = (): DigestTestEmailDeliveryRepository => ({
  claim: vi.fn().mockResolvedValue(claimed),
  succeed: vi.fn().mockResolvedValue(undefined),
  retry: vi.fn().mockResolvedValue(undefined),
  fail: vi.fn().mockResolvedValue(undefined),
});

describe('digest test email worker', () => {
  it('sends a clearly labelled test to the frozen recipient only', async () => {
    const store = repository();
    const gateway = new FakeEmailGateway();
    const finishedAt = new Date('2026-08-12T08:00:01.000Z');
    const times = [
      new Date('2026-08-12T08:00:00.000Z'),
      finishedAt,
    ];
    await new DigestTestEmailDeliveryService(store, gateway, () => times.shift()!).run(
      { testEmailId: 'test-1', userId: 'user-a' }, { finalAttempt: false },
    );

    expect(gateway.attempts[0]).toMatchObject({
      idempotencyKey: 'digest-test:test-1',
      message: { to: 'verified@example.com', subject: '[测试] LetterMate 每日研究简报投递确认' },
    });
    expect(gateway.messages[0]?.text).toContain('不会改变日报发送记录');
    expect(store.succeed).toHaveBeenCalledWith(claimed, 'fake-1', finishedAt);
  });

  it('records retryable and terminal failures with safe codes', async () => {
    const retryStore = repository();
    const retryGateway = new FakeEmailGateway([{
      type: 'fail_before_accept', code: 'EMAIL_RATE_LIMITED', retryable: true,
    }]);
    await expect(new DigestTestEmailDeliveryService(retryStore, retryGateway).run(
      { testEmailId: 'test-1', userId: 'user-a' }, { finalAttempt: false },
    )).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
    expect(retryStore.retry).toHaveBeenCalledWith(claimed, 'EMAIL_RATE_LIMITED');

    const failStore = repository();
    const failGateway = new FakeEmailGateway([{
      type: 'fail_before_accept', code: 'provider secret', retryable: false,
    }]);
    await new DigestTestEmailDeliveryService(failStore, failGateway).run(
      { testEmailId: 'test-1', userId: 'user-a' }, { finalAttempt: false },
    );
    expect(failStore.fail).toHaveBeenCalledWith(claimed, 'provider secret', expect.any(Date));
  });

  it('validates job data and passes final-attempt state', async () => {
    const service = { run: vi.fn().mockResolvedValue(undefined) };
    const handler = createDigestTestEmailJobHandler(service);
    await expect(handler({ data: { testEmailId: '', userId: 'user-a' } } as never))
      .rejects.toThrow();
    await handler({
      data: { testEmailId: 'test-1', userId: 'user-a' },
      opts: { attempts: 3 }, attemptsMade: 2,
    } as never);
    expect(service.run).toHaveBeenCalledWith(
      { testEmailId: 'test-1', userId: 'user-a' }, { finalAttempt: true },
    );
  });

  it('escapes recipient markup in the test template', () => {
    expect(renderDigestTestEmail('student+<tag>@example.com').html).toContain('&lt;tag&gt;');
  });

  it('treats unknown thrown errors as retryable gateway failures', async () => {
    const store = repository();
    const gateway = { send: vi.fn().mockRejectedValue(new Error('secret')) };
    await expect(new DigestTestEmailDeliveryService(store, gateway).run(
      { testEmailId: 'test-1', userId: 'user-a' }, { finalAttempt: false },
    )).rejects.toBeInstanceOf(EmailGatewayError);
    expect(store.retry).toHaveBeenCalledWith(claimed, 'EMAIL_GATEWAY_UNAVAILABLE');
  });
});
