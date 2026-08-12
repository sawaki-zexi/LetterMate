import { z } from 'zod';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Webhook } from 'svix';

const resendEventSchema = z.object({
  type: z.enum([
    'email.bounced',
    'email.complained',
    'email.delivery_delayed',
    'email.failed',
    'email.suppressed',
  ]),
  created_at: z.iso.datetime(),
  data: z.object({
    email_id: z.string().trim().min(1).max(200),
    bounce: z.object({
      type: z.string().trim().min(1).max(100),
    }).optional(),
  }),
}).superRefine((event, context) => {
  if (event.type === 'email.bounced' && !event.data.bounce) {
    context.addIssue({ code: 'custom', message: 'Bounce outcome is required' });
  }
});

export type EmailDeliveryEvent = {
  provider: 'resend';
  providerEventId: string;
  eventType: 'bounced' | 'complained' | 'delivery_delayed' | 'failed' | 'suppressed';
  permanence: 'permanent' | 'transient';
  providerMessageId: string;
  occurredAt: Date;
};

export class EmailDeliveryWebhookError extends Error {
  constructor(
    public readonly code: 'EMAIL_WEBHOOK_NOT_CONFIGURED'
      | 'EMAIL_WEBHOOK_SIGNATURE_INVALID'
      | 'EMAIL_WEBHOOK_EVENT_INVALID',
    public readonly status: 400 | 503,
  ) {
    super('Email delivery webhook failed');
    this.name = 'EmailDeliveryWebhookError';
  }
}

export class ResendWebhookVerifier {
  private readonly webhook: Webhook;

  constructor(secret: string) {
    this.webhook = new Webhook(secret);
  }

  verify(rawBody: Buffer, headers: {
    id: string;
    timestamp: string;
    signature: string;
  }): EmailDeliveryEvent {
    let payload: unknown;
    try {
      payload = this.webhook.verify(rawBody, {
        'svix-id': headers.id,
        'svix-timestamp': headers.timestamp,
        'svix-signature': headers.signature,
      });
    } catch {
      throw new EmailDeliveryWebhookError('EMAIL_WEBHOOK_SIGNATURE_INVALID', 400);
    }
    const parsed = resendEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw new EmailDeliveryWebhookError('EMAIL_WEBHOOK_EVENT_INVALID', 400);
    }
    const event = parsed.data;
    return {
      provider: 'resend',
      providerEventId: headers.id,
      eventType: event.type.slice('email.'.length) as EmailDeliveryEvent['eventType'],
      permanence: event.type === 'email.complained' || event.type === 'email.suppressed'
        ? 'permanent'
        : event.data.bounce?.type.toLowerCase() === 'permanent'
          ? 'permanent'
          : 'transient',
      providerMessageId: event.data.email_id,
      occurredAt: new Date(event.created_at),
    };
  }
}

export interface EmailDeliveryEventRepository {
  process(event: EmailDeliveryEvent): Promise<void>;
}

export class MemoryEmailDeliveryEventRepository implements EmailDeliveryEventRepository {
  readonly events = new Map<string, EmailDeliveryEvent>();

  async process(event: EmailDeliveryEvent): Promise<void> {
    this.events.set(`${event.provider}:${event.providerEventId}`, structuredClone(event));
  }
}

type MessageOwner = { userId: string; recipientEmail: string };

export class PrismaEmailDeliveryEventRepository implements EmailDeliveryEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async process(event: EmailDeliveryEvent): Promise<void> {
    try {
      await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.emailDeliveryEvent.findUnique({
          where: {
            provider_providerEventId: {
              provider: event.provider,
              providerEventId: event.providerEventId,
            },
          },
          select: { id: true },
        });
        if (existing) return;

        const [runs, testEmails, verifications] = await Promise.all([
          transaction.digestRun.findMany({
            where: { providerMessageId: event.providerMessageId },
            select: { userId: true, recipientEmail: true },
          }),
          transaction.digestTestEmail.findMany({
            where: { providerMessageId: event.providerMessageId },
            select: { userId: true, recipientEmail: true },
          }),
          transaction.digestEmailVerification.findMany({
            where: { providerMessageId: event.providerMessageId },
            select: { userId: true, email: true },
          }),
        ]);
        const owners = [
          ...runs.map((run) => run.recipientEmail
            ? { userId: run.userId, recipientEmail: run.recipientEmail }
            : null),
          ...testEmails.map((testEmail) => ({
            userId: testEmail.userId,
            recipientEmail: testEmail.recipientEmail,
          })),
          ...verifications.map((verification) => ({
            userId: verification.userId,
            recipientEmail: verification.email,
          })),
        ].filter((value): value is MessageOwner => value !== null);
        const owner = owners[0];
        const conflictingOwner = owners.some((value) => (
          value.userId !== owner?.userId || value.recipientEmail !== owner?.recipientEmail
        ));

        let outcome = conflictingOwner ? 'conflict' : owner ? 'ignored' : 'unmatched';
        if (owner && !conflictingOwner && event.permanence === 'permanent') {
          const reason = event.eventType === 'complained'
            ? 'complaint'
            : event.eventType === 'suppressed'
              ? 'provider_suppression'
              : 'permanent_bounce';
          await transaction.digestPreference.updateMany({
            where: {
              userId: owner.userId,
              recipientEmail: owner.recipientEmail,
            },
            data: {
              enabled: false,
              recipientStatus: 'suppressed',
              recipientSuppressionReason: reason,
              recipientSuppressedAt: event.occurredAt,
            },
          });
          outcome = 'suppressed';
        }
        await transaction.emailDeliveryEvent.create({
          data: {
            provider: event.provider,
            providerEventId: event.providerEventId,
            eventType: event.eventType,
            outcome,
            providerMessageId: event.providerMessageId,
            occurredAt: event.occurredAt,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
  }
}

export class EmailDeliveryWebhookService {
  constructor(
    private readonly verifier: ResendWebhookVerifier | null,
    private readonly repository: EmailDeliveryEventRepository,
  ) {}

  async receive(rawBody: Buffer | undefined, headers: {
    id?: string;
    timestamp?: string;
    signature?: string;
  }): Promise<{ received: true }> {
    if (!this.verifier) {
      throw new EmailDeliveryWebhookError('EMAIL_WEBHOOK_NOT_CONFIGURED', 503);
    }
    if (!rawBody || !headers.id || !headers.timestamp || !headers.signature) {
      throw new EmailDeliveryWebhookError('EMAIL_WEBHOOK_SIGNATURE_INVALID', 400);
    }
    const event = this.verifier.verify(rawBody, {
      id: headers.id,
      timestamp: headers.timestamp,
      signature: headers.signature,
    });
    await this.repository.process(event);
    return { received: true };
  }
}
