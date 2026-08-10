import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSendOptions {
  idempotencyKey: string;
}

export class EmailGatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super('Email delivery failed');
    this.name = 'EmailGatewayError';
  }
}

export interface EmailGateway {
  send(message: EmailMessage, options: EmailSendOptions): Promise<{ messageId: string }>;
}

interface SmtpTransport {
  sendMail(message: Record<string, unknown>): Promise<{
    messageId?: string;
    rejected?: unknown[];
  }>;
}

export interface SmtpEmailGatewayOptions {
  from: string;
  messageIdDomain: string;
}

export interface SmtpTransportOptions extends SmtpEmailGatewayOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user?: string;
  password?: string;
  connectionTimeoutMs: number;
  socketTimeoutMs: number;
}

interface SmtpFailure {
  code?: string;
  responseCode?: number;
}

const smtpFailure = (error: unknown): EmailGatewayError => {
  const failure = error && typeof error === 'object' ? error as SmtpFailure : {};
  if (failure.code === 'EAUTH') {
    return new EmailGatewayError('EMAIL_AUTHENTICATION_FAILED', false);
  }
  if (failure.code === 'EENVELOPE' || failure.responseCode === 550 || failure.responseCode === 551) {
    return new EmailGatewayError('EMAIL_RECIPIENT_REJECTED', false);
  }
  if (failure.responseCode === 421 || failure.responseCode === 429) {
    return new EmailGatewayError('EMAIL_RATE_LIMITED', true);
  }
  if (failure.code === 'ETIMEDOUT') {
    return new EmailGatewayError('EMAIL_TIMEOUT', true);
  }
  if (['ECONNECTION', 'ECONNRESET', 'ESOCKET', 'EHOSTUNREACH'].includes(failure.code ?? '')) {
    return new EmailGatewayError('EMAIL_CONFIRMATION_LOST', true);
  }
  if (failure.responseCode !== undefined && failure.responseCode >= 400
    && failure.responseCode < 500) {
    return new EmailGatewayError('EMAIL_PROVIDER_UNAVAILABLE', true);
  }
  return new EmailGatewayError('EMAIL_GATEWAY_UNAVAILABLE', false);
};

export class SmtpEmailGateway implements EmailGateway {
  constructor(
    private readonly transport: SmtpTransport,
    private readonly options: SmtpEmailGatewayOptions,
  ) {}

  async send(message: EmailMessage, options: EmailSendOptions): Promise<{ messageId: string }> {
    const digest = createHash('sha256').update(options.idempotencyKey).digest('hex');
    const deterministicMessageId = `<${digest}@${this.options.messageIdDomain}>`;
    try {
      const result = await this.transport.sendMail({
        from: this.options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: deterministicMessageId,
      });
      if ((result.rejected?.length ?? 0) > 0) {
        throw new EmailGatewayError('EMAIL_RECIPIENT_REJECTED', false);
      }
      return { messageId: result.messageId || deterministicMessageId };
    } catch (error) {
      if (error instanceof EmailGatewayError) throw error;
      throw smtpFailure(error);
    }
  }
}

export function createSmtpEmailGateway(options: SmtpTransportOptions): SmtpEmailGateway {
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: options.requireTls,
    connectionTimeout: options.connectionTimeoutMs,
    greetingTimeout: options.connectionTimeoutMs,
    socketTimeout: options.socketTimeoutMs,
    tls: { rejectUnauthorized: true },
    ...(options.user && options.password
      ? { auth: { user: options.user, pass: options.password } }
      : {}),
  });
  return new SmtpEmailGateway(transport as SmtpTransport, options);
}

export type FakeEmailOutcome =
  | { type: 'succeed' }
  | {
      type: 'fail_before_accept';
      code: string;
      retryable: boolean;
      retryAfterMs?: number;
    }
  | {
      type: 'accept_then_lose_confirmation';
      code: string;
      retryAfterMs?: number;
    };

export class FakeEmailGateway implements EmailGateway {
  readonly messages: EmailMessage[] = [];
  readonly attempts: Array<{ idempotencyKey: string; message: EmailMessage }> = [];
  private readonly accepted = new Map<string, {
    fingerprint: string;
    messageId: string;
  }>();

  constructor(private readonly outcomes: FakeEmailOutcome[] = []) {}

  async send(message: EmailMessage, options: EmailSendOptions): Promise<{ messageId: string }> {
    const copy = structuredClone(message);
    const fingerprint = JSON.stringify(copy);
    this.attempts.push({ idempotencyKey: options.idempotencyKey, message: copy });
    const existing = this.accepted.get(options.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new EmailGatewayError('EMAIL_IDEMPOTENCY_CONFLICT', false);
      }
      return { messageId: existing.messageId };
    }
    const outcome = this.outcomes.shift() ?? { type: 'succeed' };
    if (outcome.type === 'fail_before_accept') {
      throw new EmailGatewayError(
        outcome.code,
        outcome.retryable,
        outcome.retryAfterMs,
      );
    }
    const messageId = `fake-${this.messages.length + 1}`;
    this.messages.push(copy);
    this.accepted.set(options.idempotencyKey, { fingerprint, messageId });
    if (outcome.type === 'accept_then_lose_confirmation') {
      throw new EmailGatewayError(outcome.code, true, outcome.retryAfterMs);
    }
    return { messageId };
  }
}

export interface DigestEmailItem {
  title: string;
  summary: string;
  reason: string;
  sourceUrl: string;
  citationUrls?: readonly string[];
  platform?: string;
  publishedAt?: Date | string | null;
  evidence?: string;
  uncertainty?: string;
  followUp?: string;
}

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export function renderDigestEmail(input: {
  recipient: string;
  scheduledLocalDate: string;
  items: readonly DigestEmailItem[];
}): EmailMessage {
  const subject = `LetterMate 每日研究简报 | ${input.scheduledLocalDate}`;
  const textItems = input.items.map((item, index) => {
    const citations = [...new Set(item.citationUrls?.length ? item.citationUrls : [item.sourceUrl])];
    const publishedAt = item.publishedAt
      ? new Date(item.publishedAt).toISOString()
      : '发布时间未知';
    return [
    `${index + 1}. ${item.title}`,
    `结论：${item.summary}`,
    `证据：${item.evidence ?? item.reason}`,
    `不确定性：${item.uncertainty ?? '请打开原文核验，邮件摘要不替代原文。'}`,
    `后续关注：${item.followUp ?? '继续关注后续更新或独立来源。'}`,
    `来源平台：${item.platform ?? 'Web'} | 发布时间：${publishedAt}`,
    `引用：${citations.join(', ')}`,
  ].join('\n');
  }).join('\n\n');
  const htmlItems = input.items.map((item, index) => {
    const citations = [...new Set(item.citationUrls?.length ? item.citationUrls : [item.sourceUrl])];
    const publishedAt = item.publishedAt
      ? new Date(item.publishedAt).toISOString()
      : '发布时间未知';
    return [
    '<article>',
    `<h2>${index + 1}. ${escapeHtml(item.title)}</h2>`,
    `<p><strong>结论：</strong>${escapeHtml(item.summary)}</p>`,
    `<p><strong>证据：</strong>${escapeHtml(item.evidence ?? item.reason)}</p>`,
    `<p><strong>不确定性：</strong>${escapeHtml(item.uncertainty ?? '请打开原文核验，邮件摘要不替代原文。')}</p>`,
    `<p><strong>后续关注：</strong>${escapeHtml(item.followUp ?? '继续关注后续更新或独立来源。')}</p>`,
    `<p><strong>来源平台：</strong>${escapeHtml(item.platform ?? 'Web')} <strong>发布时间：</strong>${escapeHtml(publishedAt)}</p>`,
    `<p>${citations.map((url) => `<a href="${escapeHtml(url)}">查看引用原文</a>`).join(' | ')}</p>`,
    '</article>',
  ].join('');
  }).join('');
  return {
    to: input.recipient,
    subject,
    text: `LetterMate 每日研究简报\n${input.scheduledLocalDate}\n\n${textItems}`,
    html: [
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">',
      '<meta charset="utf-8"></head>',
      '<body style="margin:0;background:#f4f6f8;color:#18201d;font-family:Arial,sans-serif">',
      '<main style="max-width:640px;margin:0 auto;padding:24px 16px;background:#ffffff">',
      `<h1 style="font-size:24px;margin:0 0 24px">LetterMate 每日研究简报</h1>${htmlItems}`,
      '</main></body></html>',
    ].join(''),
  };
}
