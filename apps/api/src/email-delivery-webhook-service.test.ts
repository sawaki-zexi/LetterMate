import type { PrismaClient } from '@prisma/client';
import { Webhook } from 'svix';
import { describe, expect, it } from 'vitest';
import {
  EmailDeliveryWebhookService,
  PrismaEmailDeliveryEventRepository,
  ResendWebhookVerifier,
  type EmailDeliveryEvent,
  type EmailDeliveryEventRepository,
} from './email-delivery-webhook-service.js';

const secret = `whsec_${Buffer.from('resend-webhook-test-secret-32bytes').toString('base64')}`;

function signedEvent(payload: unknown, timestamp = new Date()) {
  const body = Buffer.from(JSON.stringify(payload));
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  return {
    body,
    headers: {
      id,
      timestamp: Math.floor(timestamp.getTime() / 1_000).toString(),
      signature: new Webhook(secret).sign(id, timestamp, body),
    },
  };
}

function payload(type: string, data: Record<string, unknown> = {}) {
  return {
    type,
    created_at: '2026-08-12T08:00:00.000Z',
    data: { email_id: 'email-provider-1', ...data },
  };
}

describe('ResendWebhookVerifier', () => {
  const verifier = new ResendWebhookVerifier(secret);

  it('verifies the exact raw body and normalizes permanent delivery events', () => {
    const complained = signedEvent(payload('email.complained'));
    expect(verifier.verify(complained.body, complained.headers)).toMatchObject({
      providerEventId: complained.headers.id,
      eventType: 'complained',
      permanence: 'permanent',
      providerMessageId: 'email-provider-1',
    });

    const bounced = signedEvent(payload('email.bounced', { bounce: { type: 'Permanent' } }));
    expect(verifier.verify(bounced.body, bounced.headers)).toMatchObject({
      eventType: 'bounced', permanence: 'permanent',
    });
  });

  it.each(['Temporary', 'Transient', 'Undetermined', 'FutureValue'])(
    'treats non-permanent bounce type %s as transient',
    (type) => {
      const event = signedEvent(payload('email.bounced', { bounce: { type } }));
      expect(verifier.verify(event.body, event.headers).permanence).toBe('transient');
    },
  );

  it('rejects a changed body, expired timestamp, unsupported event, and missing bounce data', () => {
    const changed = signedEvent(payload('email.complained'));
    expect(() => verifier.verify(Buffer.concat([changed.body, Buffer.from(' ')]), changed.headers))
      .toThrowError(expect.objectContaining({ code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID' }));

    const expired = signedEvent(payload('email.complained'), new Date(Date.now() - 10 * 60_000));
    expect(() => verifier.verify(expired.body, expired.headers))
      .toThrowError(expect.objectContaining({ code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID' }));

    for (const invalid of [
      signedEvent(payload('email.delivered')),
      signedEvent(payload('email.bounced')),
    ]) {
      expect(() => verifier.verify(invalid.body, invalid.headers))
        .toThrowError(expect.objectContaining({ code: 'EMAIL_WEBHOOK_EVENT_INVALID' }));
    }
  });

  it('accepts delayed and failed events without marking them permanent', () => {
    for (const type of ['email.delivery_delayed', 'email.failed']) {
      const event = signedEvent(payload(type));
      expect(verifier.verify(event.body, event.headers)).toMatchObject({ permanence: 'transient' });
    }
  });
});

describe('EmailDeliveryWebhookService', () => {
  it('requires configuration, a raw body, and all Svix headers', async () => {
    const repository: EmailDeliveryEventRepository = { process: async () => undefined };
    await expect(new EmailDeliveryWebhookService(null, repository).receive(Buffer.from('{}'), {}))
      .rejects.toMatchObject({ code: 'EMAIL_WEBHOOK_NOT_CONFIGURED', status: 503 });
    await expect(new EmailDeliveryWebhookService(
      new ResendWebhookVerifier(secret), repository,
    ).receive(undefined, {})).rejects.toMatchObject({
      code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID', status: 400,
    });
  });

  it('passes only the normalized event to persistence', async () => {
    const events: EmailDeliveryEvent[] = [];
    const repository: EmailDeliveryEventRepository = {
      process: async (event) => { events.push(event); },
    };
    const signed = signedEvent({
      ...payload('email.complained'),
      secret_payload: 'must-not-reach-persistence',
      data: {
        email_id: 'email-provider-1',
        to: ['student@example.com'],
        subject: 'private subject',
      },
    });
    await expect(new EmailDeliveryWebhookService(
      new ResendWebhookVerifier(secret), repository,
    ).receive(signed.body, signed.headers)).resolves.toEqual({ received: true });
    expect(events).toEqual([expect.objectContaining({
      providerMessageId: 'email-provider-1', eventType: 'complained',
    })]);
    expect(JSON.stringify(events)).not.toContain('student@example.com');
    expect(JSON.stringify(events)).not.toContain('private subject');
  });
});

type Owner = { userId: string; recipientEmail: string | null };

function repositoryFixture(input: {
  runs?: Owner[];
  tests?: Array<{ userId: string; recipientEmail: string }>;
  verifications?: Array<{ userId: string; email: string }>;
} = {}) {
  const deliveryEvents: Array<Record<string, unknown>> = [];
  const preferenceUpdates: Array<Record<string, unknown>> = [];
  const transaction = {
    emailDeliveryEvent: {
      findUnique: async ({ where }: { where: { provider_providerEventId: { providerEventId: string } } }) => (
        deliveryEvents.some((event) => event.providerEventId === where.provider_providerEventId.providerEventId)
          ? { id: 'existing' }
          : null
      ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        deliveryEvents.push(structuredClone(data));
        return data;
      },
    },
    digestRun: { findMany: async () => input.runs ?? [] },
    digestTestEmail: { findMany: async () => input.tests ?? [] },
    digestEmailVerification: { findMany: async () => input.verifications ?? [] },
    digestPreference: {
      updateMany: async (value: Record<string, unknown>) => {
        preferenceUpdates.push(structuredClone(value));
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (value: typeof transaction) => Promise<void>) => callback(transaction),
  } as unknown as PrismaClient;
  return {
    repository: new PrismaEmailDeliveryEventRepository(prisma),
    deliveryEvents,
    preferenceUpdates,
  };
}

const normalizedEvent = (overrides: Partial<EmailDeliveryEvent> = {}): EmailDeliveryEvent => ({
  provider: 'resend',
  providerEventId: 'evt-1',
  eventType: 'bounced',
  permanence: 'permanent',
  providerMessageId: 'email-provider-1',
  occurredAt: new Date('2026-08-12T08:00:00.000Z'),
  ...overrides,
});

describe('PrismaEmailDeliveryEventRepository', () => {
  it('suppresses an address located through the provider message ID and is idempotent', async () => {
    const fixture = repositoryFixture({
      runs: [{ userId: 'user-a', recipientEmail: 'student@example.com' }],
    });
    await fixture.repository.process(normalizedEvent());
    await fixture.repository.process(normalizedEvent());
    expect(fixture.preferenceUpdates).toEqual([expect.objectContaining({
      where: { userId: 'user-a', recipientEmail: 'student@example.com' },
      data: expect.objectContaining({
        enabled: false,
        recipientStatus: 'suppressed',
        recipientSuppressionReason: 'permanent_bounce',
      }),
    })]);
    expect(fixture.deliveryEvents).toHaveLength(1);
    expect(fixture.deliveryEvents[0]).toMatchObject({ outcome: 'suppressed' });
    expect(JSON.stringify(fixture.deliveryEvents)).not.toContain('student@example.com');
  });

  it('suppresses complaints and provider suppression, but ignores transient events', async () => {
    for (const [eventType, reason] of [
      ['complained', 'complaint'],
      ['suppressed', 'provider_suppression'],
    ] as const) {
      const fixture = repositoryFixture({
        tests: [{ userId: 'user-a', recipientEmail: 'student@example.com' }],
      });
      await fixture.repository.process(normalizedEvent({ providerEventId: eventType, eventType }));
      expect(fixture.preferenceUpdates[0]).toMatchObject({
        data: { recipientSuppressionReason: reason },
      });
    }

    const transient = repositoryFixture({
      verifications: [{ userId: 'user-a', email: 'student@example.com' }],
    });
    await transient.repository.process(normalizedEvent({
      permanence: 'transient', eventType: 'delivery_delayed',
    }));
    expect(transient.preferenceUpdates).toHaveLength(0);
    expect(transient.deliveryEvents[0]).toMatchObject({ outcome: 'ignored' });
  });

  it('records unmatched and conflicting message ownership without changing a recipient', async () => {
    const unmatched = repositoryFixture();
    await unmatched.repository.process(normalizedEvent());
    expect(unmatched.preferenceUpdates).toHaveLength(0);
    expect(unmatched.deliveryEvents[0]).toMatchObject({ outcome: 'unmatched' });

    const conflict = repositoryFixture({
      runs: [{ userId: 'user-a', recipientEmail: 'a@example.com' }],
      tests: [{ userId: 'user-b', recipientEmail: 'b@example.com' }],
    });
    await conflict.repository.process(normalizedEvent());
    expect(conflict.preferenceUpdates).toHaveLength(0);
    expect(conflict.deliveryEvents[0]).toMatchObject({ outcome: 'conflict' });
  });
});
