import { parseConfig } from '@lettermate/config';
import { describe, expect, it } from 'vitest';
import { createResendEmailGateway, renderDigestEmail } from './digest-email.js';

const liveEnabled = process.env.RUN_LIVE_RESEND_TESTS === '1';

describe.skipIf(!liveEnabled)('live Resend email gateway', () => {
  it('sends one explicitly enabled smoke message', async () => {
    const config = parseConfig(process.env);
    if (config.EMAIL_PROVIDER !== 'resend' || !config.RESEND_API_KEY || !config.RESEND_FROM
      || !config.RESEND_SMOKE_RECIPIENT) {
      throw new Error(
        'RUN_LIVE_RESEND_TESTS requires EMAIL_PROVIDER=resend, RESEND_API_KEY, '
        + 'RESEND_FROM, and RESEND_SMOKE_RECIPIENT',
      );
    }
    const gateway = createResendEmailGateway({
      apiKey: config.RESEND_API_KEY,
      baseUrl: config.RESEND_API_BASE_URL,
      from: config.RESEND_FROM,
      timeoutMs: config.RESEND_TIMEOUT_MS,
    });
    const idempotencyKey = `resend-smoke:${new Date().toISOString()}`;
    const result = await gateway.send(renderDigestEmail({
      recipient: config.RESEND_SMOKE_RECIPIENT,
      scheduledLocalDate: new Date().toISOString().slice(0, 10),
      items: [{
        title: 'LetterMate Resend smoke test',
        summary: '这是一封由显式 live smoke 开关触发的测试邮件。',
        reason: '验证目标环境的 Resend API、发件域名和投递路径。',
        sourceUrl: 'https://github.com/sawaki-zexi/LetterMate',
      }],
    }), { idempotencyKey });

    expect(result.messageId).toBeTruthy();
  });
});
