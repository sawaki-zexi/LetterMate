import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  attachWorkerLogging,
  startQueueMetricsReporter,
  writeAgentStageLog,
} from './observability.js';
import type { Job, Worker } from 'bullmq';

describe('worker observability', () => {
  it('logs bounded job identifiers without raw error messages or user data', () => {
    const emitter = new EventEmitter();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = {
      recordJob: vi.fn(), recordQueueSnapshot: vi.fn(), recordAgentStage: vi.fn(),
    };
    attachWorkerLogging(
      emitter as unknown as Worker<{ runId: string; userId: string }>,
      'daily-digest',
      logger,
      () => new Date('2026-08-08T08:00:00.000Z'),
      metrics,
    );
    const error = Object.assign(new Error('smtp://user:secret@example.com'), { code: 'SMTP_TIMEOUT' });
    emitter.emit('failed', {
      id: 'job-1', attemptsMade: 1, data: { runId: 'run-1', userId: 'private-user' },
    } as Job, error);

    const entry = JSON.parse(logger.error.mock.calls[0]?.[0] as string);
    expect(entry).toMatchObject({
      service: 'worker', event: 'queue.job.failed', queue: 'daily-digest',
      runId: 'run-1', jobId: 'job-1', attempt: 2, code: 'SMTP_TIMEOUT',
    });
    expect(JSON.stringify(entry)).not.toContain('private-user');
    expect(JSON.stringify(entry)).not.toContain('secret');
    expect(metrics.recordJob).toHaveBeenCalledWith('daily-digest', 'failed', 'SMTP_TIMEOUT');
  });

  it('reports queue backlog snapshots and safe Redis failures', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = {
      recordJob: vi.fn(), recordQueueSnapshot: vi.fn(), recordAgentStage: vi.fn(),
    };
    const reporter = startQueueMetricsReporter('topic-discovery', {
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 12, active: 2, delayed: 1, failed: 3 }),
    }, {
      logger, metrics, intervalMs: 60_000,
      now: () => new Date('2026-08-08T08:00:00.000Z'),
    });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    expect(JSON.parse(logger.warn.mock.calls[0]?.[0] as string)).toMatchObject({
      event: 'queue.snapshot',
      counts: { waiting: 12, active: 2, delayed: 1, failed: 3 },
    });
    expect(metrics.recordQueueSnapshot).toHaveBeenCalledWith('topic-discovery', {
      waiting: 12, active: 2, delayed: 1, failed: 3,
    });
    reporter.close();
  });

  it('logs bounded Agent stages and aggregate counts without content data', () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = {
      recordJob: vi.fn(), recordQueueSnapshot: vi.fn(), recordAgentStage: vi.fn(),
    };
    writeAgentStageLog(logger, 'topic', {
      runId: 'run-1',
      stage: 'quality_gate',
      durationMs: 18.9,
      inputCount: 12,
      outputCount: 3,
      failureCount: 1,
    }, new Date('2026-08-08T08:00:00.000Z'), metrics);

    const entry = JSON.parse(logger.log.mock.calls[0]?.[0] as string);
    expect(entry).toMatchObject({
      event: 'agent.stage.completed', component: 'topic', runId: 'run-1',
      stage: 'quality_gate', durationMs: 18,
      metrics: { inputCount: 12, outputCount: 3, failureCount: 1 },
    });
    expect(entry).not.toHaveProperty('keyword');
    expect(entry).not.toHaveProperty('url');
    expect(metrics.recordAgentStage).toHaveBeenCalledWith(expect.objectContaining({
      component: 'topic', stage: 'quality_gate', durationMs: 18.9,
    }));
  });
});
