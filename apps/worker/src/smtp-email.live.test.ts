import { parseConfig } from '@lettermate/config';
import { describe, expect, it } from 'vitest';
import { createSmtpEmailGateway, renderDigestEmail } from './digest-email.js';

const liveEnabled = process.env.RUN_LIVE_EMAIL_TESTS === '1';

describe.skipIf(!liveEnabled)('live SMTP email gateway', () => {
  it('sends one explicitly enabled smoke message', async () => {
    const config = parseConfig(process.env);
    if (config.EMAIL_PROVIDER !== 'smtp' || !config.SMTP_HOST || !config.SMTP_FROM
      || !config.SMTP_SMOKE_RECIPIENT) {
      throw new Error(
        'RUN_LIVE_EMAIL_TESTS requires EMAIL_PROVIDER=smtp, SMTP_HOST, SMTP_FROM, '
        + 'and SMTP_SMOKE_RECIPIENT',
      );
    }
    const gateway = createSmtpEmailGateway({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      requireTls: config.SMTP_REQUIRE_TLS,
      from: config.SMTP_FROM,
      messageIdDomain: config.SMTP_MESSAGE_ID_DOMAIN,
      connectionTimeoutMs: config.SMTP_CONNECTION_TIMEOUT_MS,
      socketTimeoutMs: config.SMTP_SOCKET_TIMEOUT_MS,
      ...(config.SMTP_USER && config.SMTP_PASSWORD
        ? { user: config.SMTP_USER, password: config.SMTP_PASSWORD }
        : {}),
    });
    const idempotencyKey = `smtp-smoke:${new Date().toISOString()}`;
    const result = await gateway.send(renderDigestEmail({
      recipient: config.SMTP_SMOKE_RECIPIENT,
      scheduledLocalDate: new Date().toISOString().slice(0, 10),
      items: [{
        title: 'LetterMate SMTP smoke test',
        summary: '这是一封由显式 live smoke 开关触发的测试邮件。',
        reason: '验证目标环境的 SMTP 配置、TLS 和投递路径。',
        sourceUrl: 'https://github.com/sawaki-zexi/LetterMate',
      }],
    }), { idempotencyKey });

    expect(result.messageId).toBeTruthy();
  });
});
