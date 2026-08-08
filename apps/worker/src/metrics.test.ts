import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WorkerMetrics, startWorkerMetricsServer } from './metrics.js';

const get = (port: number, path: string): Promise<{ status: number; body: string }> => (
  new Promise((resolvePromise, reject) => {
    const operation = request({ host: '127.0.0.1', port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolvePromise({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    operation.once('error', reject);
    operation.end();
  })
);

describe('Worker metrics', () => {
  it('records bounded queue and Agent stage metrics', async () => {
    const metrics = new WorkerMetrics();
    metrics.recordQueueSnapshot('topic-discovery', {
      waiting: 12, active: 2, delayed: 1, failed: 3,
    });
    metrics.recordJob('topic-discovery', 'failed', 'AI_RATE_LIMITED');
    metrics.recordJob('private user@example.com', 'failed', 'https://secret.example.com');
    metrics.recordAgentStage({
      component: 'topic',
      stage: 'quality_gate',
      durationMs: 1_500,
      inputCount: 12,
      outputCount: 3,
      failureCount: 1,
    });

    const output = await metrics.render();
    expect(output).toContain(
      'lettermate_worker_queue_jobs{queue="topic-discovery",state="waiting"} 12',
    );
    expect(output).toContain('result="failed",code="AI_RATE_LIMITED"');
    expect(output).toContain('queue="unknown",result="failed",code="unknown"');
    expect(output).not.toContain('secret.example.com');
    expect(output).toContain('component="topic",stage="quality_gate"');
    expect(output).not.toContain('runId');
  });

  it('serves health and metrics on an internal HTTP server', async () => {
    const metrics = new WorkerMetrics();
    const server = await startWorkerMetricsServer(metrics, 0, '127.0.0.1');
    metrics.recordJob('daily-digest', 'completed');
    await expect(get(server.port, '/health')).resolves.toEqual({
      status: 200, body: '{"status":"ok"}',
    });
    await expect(get(server.port, '/metrics')).resolves.toMatchObject({
      status: 200,
      body: expect.stringContaining('lettermate_worker_job_events_total'),
    });
    await expect(get(server.port, '/missing')).resolves.toMatchObject({ status: 404 });
    await server.close();
  });
});
