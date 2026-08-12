import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: {
    'List-Unsubscribe': string;
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click';
  };
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

export function renderDigestTestEmail(recipient: string): EmailMessage {
  const safeRecipient = escapeHtml(recipient);
  return {
    to: recipient,
    subject: '[测试] LetterMate 每日研究简报投递确认',
    text: [
      '这是一封 LetterMate 测试邮件。',
      '',
      '收到此邮件说明当前收件邮箱和系统邮件投递已经连通。',
      '这不是正式的每日研究简报，不会改变日报发送记录。',
    ].join('\n'),
    html: [
      '<main style="font-family:system-ui,sans-serif;line-height:1.6;color:#17202a">',
      '<h1 style="font-size:22px">LetterMate 测试邮件</h1>',
      '<p>收到此邮件说明当前收件邮箱和系统邮件投递已经连通。</p>',
      `<p>已验证收件邮箱：${safeRecipient}</p>`,
      '<p><strong>这不是正式的每日研究简报，不会改变日报发送记录。</strong></p>',
      '</main>',
    ].join(''),
  };
}

export interface ResendEmailGatewayOptions {
  apiKey: string;
  baseUrl: string;
  from: string;
  timeoutMs: number;
}

export type EmailHttpClient = typeof fetch;

const retryAfterMs = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

const resendFailure = (status: number, retryAfter: string | null): EmailGatewayError => {
  if (status === 401 || status === 403) {
    return new EmailGatewayError('EMAIL_AUTHENTICATION_FAILED', false);
  }
  if (status === 409) {
    return new EmailGatewayError('EMAIL_IDEMPOTENCY_CONFLICT', false);
  }
  if (status === 429) {
    return new EmailGatewayError('EMAIL_RATE_LIMITED', true, retryAfterMs(retryAfter));
  }
  if (status >= 500) {
    return new EmailGatewayError('EMAIL_PROVIDER_UNAVAILABLE', true);
  }
  return new EmailGatewayError('EMAIL_GATEWAY_UNAVAILABLE', false);
};

export class ResendEmailGateway implements EmailGateway {
  constructor(
    private readonly http: EmailHttpClient,
    private readonly options: ResendEmailGatewayOptions,
  ) {}

  async send(message: EmailMessage, options: EmailSendOptions): Promise<{ messageId: string }> {
    let response: Response;
    try {
      response = await this.http(`${this.options.baseUrl.replace(/\/$/, '')}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': options.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.headers ? { headers: message.headers } : {}),
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new EmailGatewayError('EMAIL_TIMEOUT', true);
      }
      throw new EmailGatewayError('EMAIL_CONFIRMATION_LOST', true);
    }
    if (!response.ok) {
      throw resendFailure(response.status, response.headers.get('retry-after'));
    }
    try {
      const result = await response.json() as { id?: unknown };
      if (typeof result.id !== 'string' || result.id.length === 0) {
        throw new Error('missing id');
      }
      return { messageId: result.id };
    } catch {
      throw new EmailGatewayError('EMAIL_CONFIRMATION_LOST', true);
    }
  }
}

export const createResendEmailGateway = (
  options: ResendEmailGatewayOptions,
  http: EmailHttpClient = fetch,
): ResendEmailGateway => new ResendEmailGateway(http, options);

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
        ...(message.headers ? { headers: message.headers } : {}),
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

export function renderDigestVerificationEmail(input: {
  recipient: string;
  verificationUrl: string;
  expiresAt: string;
}): EmailMessage {
  const expiry = new Date(input.expiresAt).toISOString();
  const url = escapeHtml(input.verificationUrl);
  return {
    to: input.recipient,
    subject: '确认接收 LetterMate 每日研究简报',
    text: [
      '请确认这个邮箱用于接收 LetterMate 每日研究简报。',
      '',
      input.verificationUrl,
      '',
      `链接有效期至：${expiry}`,
      '如果不是你发起的请求，可以忽略这封邮件。',
    ].join('\n'),
    html: [
      '<!doctype html><html><head><meta charset="utf-8"></head>',
      '<body style="font-family:Arial,sans-serif;color:#18201d">',
      '<main style="max-width:560px;margin:0 auto;padding:24px">',
      '<h1 style="font-size:22px">确认接收 LetterMate 每日研究简报</h1>',
      '<p>请点击下面的按钮确认这个邮箱由你控制，并同意接收每日简报。</p>',
      `<p><a href="${url}" style="display:inline-block;padding:10px 16px;background:#167149;color:#fff;text-decoration:none">确认收件邮箱</a></p>`,
      `<p style="color:#52606b;font-size:12px">链接有效期至：${escapeHtml(expiry)}</p>`,
      '<p style="color:#52606b;font-size:12px">如果不是你发起的请求，可以忽略这封邮件。</p>',
      '</main></body></html>',
    ].join(''),
  };
}

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function renderDigestEmailBody(input: {
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

export function renderDigestEmail(input: {
  recipient: string;
  scheduledLocalDate: string;
  items: readonly DigestEmailItem[];
  unsubscribeUrl?: string;
  oneClickUnsubscribeUrl?: string;
}): EmailMessage {
  const message = renderDigestEmailBody(input);
  if (!input.unsubscribeUrl || !input.oneClickUnsubscribeUrl) return message;
  return {
    ...message,
    text: `${message.text}\n\n退订每日邮件：${input.unsubscribeUrl}`,
    html: message.html.replace(
      '</main>',
      `<footer style="margin-top:32px;padding-top:16px;border-top:1px solid #d8dee4;color:#52606b;font-size:12px"><a href="${escapeHtml(input.unsubscribeUrl)}">退订每日邮件</a></footer></main>`,
    ),
    headers: {
      'List-Unsubscribe': `<${input.oneClickUnsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
