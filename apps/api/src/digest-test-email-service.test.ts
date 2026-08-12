import { describe, expect, it, vi } from 'vitest';
import { MemoryDigestTestEmailQueue } from './digest-test-email-queue.js';
import {
  DigestTestEmailService,
  MemoryDigestTestEmailRepository,
} from './digest-test-email-service.js';

describe('digest test email service', () => {
  it('freezes the verified recipient and reuses one request in the idempotency bucket', async () => {
    const repository = new MemoryDigestTestEmailRepository();
    const queue = new MemoryDigestTestEmailQueue();
    const recipients = {
      get: vi.fn().mockResolvedValue({ email: 'student@example.com', status: 'verified' }),
    };
    const service = new DigestTestEmailService(
      repository, recipients, queue, true,
      () => new Date('2026-08-12T08:01:00.000Z'),
    );

    const first = await service.request('user-a');
    const second = await service.request('user-a');

    expect(second).toEqual(first);
    expect(queue.jobs).toEqual([{ testEmailId: first.id, userId: 'user-a' }]);
    expect(repository.records.get(first.id)).toMatchObject({
      recipientEmail: 'student@example.com', status: 'queued',
    });
    expect(first).not.toHaveProperty('recipientEmail');
  });

  it('does not reuse a test record after the verified recipient changes', async () => {
    const repository = new MemoryDigestTestEmailRepository();
    const queue = new MemoryDigestTestEmailQueue();
    const recipients = {
      get: vi.fn()
        .mockResolvedValueOnce({ email: 'first@example.com', status: 'verified' })
        .mockResolvedValueOnce({ email: 'second@example.com', status: 'verified' }),
    };
    const service = new DigestTestEmailService(
      repository, recipients, queue, true,
      () => new Date('2026-08-12T08:01:00.000Z'),
    );

    const first = await service.request('user-a');
    const second = await service.request('user-a');

    expect(second.id).not.toBe(first.id);
    expect(queue.jobs).toHaveLength(2);
    expect(repository.records.get(second.id)?.recipientEmail).toBe('second@example.com');
  });

  it('requires configured delivery and a current verified recipient', async () => {
    const queue = new MemoryDigestTestEmailQueue();
    const repository = new MemoryDigestTestEmailRepository();
    const recipients = { get: vi.fn().mockResolvedValue({ email: null, status: 'unverified' }) };

    await expect(new DigestTestEmailService(repository, recipients, queue, false).request('user-a'))
      .rejects.toMatchObject({ code: 'DIGEST_DELIVERY_NOT_CONFIGURED', status: 503 });
    await expect(new DigestTestEmailService(repository, recipients, queue, true).request('user-a'))
      .rejects.toMatchObject({ code: 'DIGEST_RECIPIENT_NOT_VERIFIED', status: 409 });
    expect(queue.jobs).toHaveLength(0);
  });

  it('limits new requests and hides records across users', async () => {
    const repository = new MemoryDigestTestEmailRepository();
    const queue = new MemoryDigestTestEmailQueue();
    const recipients = {
      get: vi.fn().mockResolvedValue({ email: 'student@example.com', status: 'verified' }),
    };
    let now = new Date('2026-08-12T08:01:00.000Z');
    const service = new DigestTestEmailService(repository, recipients, queue, true, () => now);

    const first = await service.request('user-a');
    now = new Date('2026-08-12T08:06:00.000Z');
    await service.request('user-a');
    now = new Date('2026-08-12T08:11:00.000Z');
    await service.request('user-a');
    now = new Date('2026-08-12T08:16:00.000Z');
    await expect(service.request('user-a')).rejects.toMatchObject({
      code: 'DIGEST_TEST_EMAIL_RATE_LIMITED', status: 429,
    });
    await expect(service.get('user-b', first.id)).rejects.toMatchObject({
      code: 'DIGEST_TEST_EMAIL_NOT_FOUND', status: 404,
    });
  });

  it('marks the record failed when enqueueing is unavailable', async () => {
    const repository = new MemoryDigestTestEmailRepository();
    const queue = { enqueue: vi.fn().mockRejectedValue(new Error('redis unavailable')), close: vi.fn() };
    const service = new DigestTestEmailService(
      repository,
      { get: vi.fn().mockResolvedValue({ email: 'student@example.com', status: 'verified' }) },
      queue,
      true,
      () => new Date('2026-08-12T08:01:00.000Z'),
    );

    await expect(service.request('user-a')).rejects.toMatchObject({
      code: 'DIGEST_TEST_EMAIL_QUEUE_UNAVAILABLE', status: 503,
    });
    expect([...repository.records.values()][0]).toMatchObject({
      status: 'failed', errorCode: 'DIGEST_TEST_EMAIL_QUEUE_UNAVAILABLE',
    });
  });
});
