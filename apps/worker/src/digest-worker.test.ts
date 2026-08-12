import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { EmailGatewayError, FakeEmailGateway } from './digest-email.js';
import {
  DigestDeliveryService,
  type ClaimedDigestRun,
  type DigestDeliveryRepository,
} from './digest-service.js';
import { createDigestJobHandler, digestBackoffStrategy } from './digest-worker.js';

const claimedRun = (): ClaimedDigestRun => ({
  runId: 'run-1',
  userId: 'user-a',
  scheduledLocalDate: '2026-08-08',
  recipient: 'student@example.com',
  unsubscribeTokenId: '11111111-1111-4111-8111-111111111111',
  leaseUntil: new Date('2026-08-08T00:10:00.000Z'),
  items: [{
    contentKey: 'https://example.com/1',
    position: 0,
    title: '冻结标题',
    summary: '冻结摘要',
    reason: '冻结理由',
    sourceUrl: 'https://example.com/1',
    citationUrls: ['https://example.com/1'],
    platform: 'Example',
    publishedAt: null,
    evidence: '冻结理由',
    uncertainty: '仍需核验原文。',
    followUp: '继续关注后续更新。',
  }],
});

const repositoryFor = (run: ClaimedDigestRun | null): DigestDeliveryRepository => ({
  claim: vi.fn().mockResolvedValue(run),
  succeed: vi.fn().mockResolvedValue(undefined),
  retry: vi.fn().mockResolvedValue(undefined),
  fail: vi.fn().mockResolvedValue(undefined),
  skip: vi.fn().mockResolvedValue(undefined),
});

describe('digest delivery worker', () => {
  it('sends the frozen snapshot to the verified recipient and marks success', async () => {
    const run = claimedRun();
    const repository = repositoryFor(run);
    const gateway = new FakeEmailGateway();
    const times = [
      new Date('2026-08-08T00:00:00.000Z'),
      new Date('2026-08-08T00:00:01.000Z'),
    ];
    const service = new DigestDeliveryService(repository, gateway, () => times.shift()!);

    await service.run({ runId: 'run-1', userId: 'user-a' });

    expect(gateway.messages[0]).toMatchObject({ to: 'student@example.com' });
    expect(gateway.messages[0]?.text).toContain('冻结标题');
    expect(gateway.messages[0]?.text).toContain('/digest/unsubscribe?token=');
    expect(gateway.messages[0]?.headers?.['List-Unsubscribe']).toContain(
      '/api/v1/digest/unsubscribe?token=',
    );
    expect(repository.succeed).toHaveBeenCalledWith(
      run, 'fake-1', new Date('2026-08-08T00:00:01.000Z'),
    );
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('skips a defensively empty claimed run without calling the gateway', async () => {
    const run = { ...claimedRun(), items: [] };
    const repository = repositoryFor(run);
    const gateway = new FakeEmailGateway();
    const service = new DigestDeliveryService(
      repository,
      gateway,
      () => new Date('2026-08-08T00:00:00.000Z'),
    );

    await service.run({ runId: 'run-1', userId: 'user-a' });

    expect(gateway.messages).toHaveLength(0);
    expect(repository.skip).toHaveBeenCalledWith(run, new Date('2026-08-08T00:00:00.000Z'));
  });

  it('validates job ownership data before invoking the service', async () => {
    const service = { run: vi.fn() };
    const handler = createDigestJobHandler(service);
    await expect(handler({ data: { runId: '', userId: 'user-a' } } as Job)).rejects.toThrow();
    expect(service.run).not.toHaveBeenCalled();
  });

  it('requeues a retryable pre-accept failure without changing the frozen snapshot', async () => {
    const run = claimedRun();
    const repository = repositoryFor(run);
    const gateway = new FakeEmailGateway([{
      type: 'fail_before_accept', code: 'EMAIL_RATE_LIMITED',
      retryable: true, retryAfterMs: 30_000,
    }]);
    const service = new DigestDeliveryService(
      repository,
      gateway,
      () => new Date('2026-08-08T00:00:00.000Z'),
    );

    await expect(service.run(
      { runId: 'run-1', userId: 'user-a' },
      { finalAttempt: false },
    )).rejects.toMatchObject({
      code: 'EMAIL_RATE_LIMITED', retryable: true,
    });

    expect(gateway.messages).toHaveLength(0);
    expect(repository.retry).toHaveBeenCalledWith(run, 'EMAIL_RATE_LIMITED');
    expect(repository.fail).not.toHaveBeenCalled();
    expect(run.items[0]?.title).toBe('冻结标题');
  });

  it('marks a retryable failure terminal only on the final attempt', async () => {
    const run = claimedRun();
    const repository = repositoryFor(run);
    const gateway = new FakeEmailGateway([{
      type: 'fail_before_accept', code: 'EMAIL_TIMEOUT', retryable: true,
    }]);
    const service = new DigestDeliveryService(
      repository,
      gateway,
      () => new Date('2026-08-08T00:00:00.000Z'),
    );

    await expect(service.run(
      { runId: 'run-1', userId: 'user-a' },
      { finalAttempt: true },
    )).resolves.toBeUndefined();

    expect(repository.fail).toHaveBeenCalledWith(
      run, 'EMAIL_TIMEOUT', new Date('2026-08-08T00:00:00.000Z'),
    );
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it('marks a nonretryable provider rejection terminal immediately', async () => {
    const run = claimedRun();
    const repository = repositoryFor(run);
    const gateway = new FakeEmailGateway([{
      type: 'fail_before_accept', code: 'EMAIL_RECIPIENT_REJECTED', retryable: false,
    }]);
    const service = new DigestDeliveryService(repository, gateway);

    await expect(service.run(
      { runId: 'run-1', userId: 'user-a' },
      { finalAttempt: false },
    )).resolves.toBeUndefined();

    expect(repository.fail).toHaveBeenCalledWith(
      run, 'EMAIL_RECIPIENT_REJECTED', expect.any(Date),
    );
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it('recovers a lost provider confirmation without accepting a second message', async () => {
    const run = claimedRun();
    const repository = repositoryFor(run);
    (repository.claim as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(run);
    const gateway = new FakeEmailGateway([{
      type: 'accept_then_lose_confirmation', code: 'EMAIL_CONFIRMATION_LOST',
    }]);
    const service = new DigestDeliveryService(
      repository,
      gateway,
      () => new Date('2026-08-08T00:00:00.000Z'),
    );

    await expect(service.run(
      { runId: 'run-1', userId: 'user-a' },
      { finalAttempt: false },
    )).rejects.toMatchObject({ code: 'EMAIL_CONFIRMATION_LOST' });
    await expect(service.run(
      { runId: 'run-1', userId: 'user-a' },
      { finalAttempt: true },
    )).resolves.toBeUndefined();

    expect(gateway.messages).toHaveLength(1);
    expect(gateway.attempts).toHaveLength(2);
    expect(repository.succeed).toHaveBeenCalledWith(
      run, 'fake-1', new Date('2026-08-08T00:00:00.000Z'),
    );
  });

  it('does not send again when a duplicate job cannot claim the run', async () => {
    const run = claimedRun();
    const repository = repositoryFor(run);
    (repository.claim as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(null);
    const gateway = new FakeEmailGateway();
    const service = new DigestDeliveryService(repository, gateway);

    await service.run({ runId: 'run-1', userId: 'user-a' });
    await service.run({ runId: 'run-1', userId: 'user-a' });

    expect(gateway.messages).toHaveLength(1);
    expect(repository.succeed).toHaveBeenCalledTimes(1);
  });

  it('reuses the provider idempotency result after a success commit failure', async () => {
    const run = claimedRun();
    const repository = repositoryFor(run);
    (repository.claim as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(run);
    (repository.succeed as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined);
    const gateway = new FakeEmailGateway();
    const service = new DigestDeliveryService(repository, gateway);

    await expect(service.run({ runId: 'run-1', userId: 'user-a' }))
      .rejects.toThrow('database unavailable');
    await expect(service.run({ runId: 'run-1', userId: 'user-a' }))
      .resolves.toBeUndefined();

    expect(gateway.messages).toHaveLength(1);
    expect(gateway.attempts).toHaveLength(2);
    expect(repository.succeed).toHaveBeenLastCalledWith(run, 'fake-1', expect.any(Date));
  });

  it('passes final-attempt state to the delivery service and uses bounded backoff', async () => {
    const service = { run: vi.fn().mockResolvedValue(undefined) };
    const handler = createDigestJobHandler(service);
    await handler({
      data: { runId: 'run-1', userId: 'user-a' },
      opts: { attempts: 4 },
      attemptsMade: 2,
    } as Job);
    expect(service.run).toHaveBeenCalledWith(
      { runId: 'run-1', userId: 'user-a' },
      { finalAttempt: false },
    );
    await handler({
      data: { runId: 'run-1', userId: 'user-a' },
      opts: { attempts: 4 },
      attemptsMade: 3,
    } as Job);
    expect(service.run).toHaveBeenLastCalledWith(
      { runId: 'run-1', userId: 'user-a' },
      { finalAttempt: true },
    );
    expect(digestBackoffStrategy(1, 'digest', new Error('network'))).toBe(5_000);
    expect(digestBackoffStrategy(99, 'digest', new Error('network'))).toBe(300_000);
    expect(digestBackoffStrategy(
      1,
      'digest',
      new EmailGatewayError('EMAIL_RATE_LIMITED', true, 45_000),
    )).toBe(45_000);
  });
});
