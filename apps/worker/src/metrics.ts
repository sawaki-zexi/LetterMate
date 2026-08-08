import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { AgentRunStage } from '@lettermate/contracts';

export interface WorkerQueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export type WorkerJobResult = 'completed' | 'failed' | 'stalled' | 'worker_error';

const boundedMetricIdentifier = (value: string): string => (
  value.length > 0 && value.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : 'unknown'
);

export interface WorkerMetricsSink {
  recordQueueSnapshot(queue: string, counts: WorkerQueueCounts): void;
  recordJob(queue: string, result: WorkerJobResult, code?: string): void;
  recordAgentStage(input: {
    component: 'topic' | 'trend';
    stage: AgentRunStage;
    durationMs: number;
    inputCount?: number;
    outputCount?: number;
    failureCount?: number;
  }): void;
}

export class WorkerMetrics implements WorkerMetricsSink {
  readonly registry = new Registry();
  private readonly queueJobs = new Gauge({
    name: 'lettermate_worker_queue_jobs',
    help: 'Current jobs in a LetterMate BullMQ queue by state.',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });
  private readonly jobEvents = new Counter({
    name: 'lettermate_worker_job_events_total',
    help: 'LetterMate Worker job lifecycle events.',
    labelNames: ['queue', 'result', 'code'] as const,
    registers: [this.registry],
  });
  private readonly stageDuration = new Histogram({
    name: 'lettermate_worker_agent_stage_duration_seconds',
    help: 'LetterMate Agent stage duration in seconds.',
    labelNames: ['component', 'stage'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    registers: [this.registry],
  });
  private readonly stageItems = new Counter({
    name: 'lettermate_worker_agent_stage_items_total',
    help: 'Aggregate item counts reported by LetterMate Agent stages.',
    labelNames: ['component', 'stage', 'kind'] as const,
    registers: [this.registry],
  });

  recordQueueSnapshot(queue: string, counts: WorkerQueueCounts): void {
    const safeQueue = boundedMetricIdentifier(queue);
    for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
      this.queueJobs.set({ queue: safeQueue, state }, Math.max(0, counts[state]));
    }
  }

  recordJob(queue: string, result: WorkerJobResult, code = 'none'): void {
    this.jobEvents.inc({
      queue: boundedMetricIdentifier(queue),
      result,
      code: boundedMetricIdentifier(code),
    });
  }

  recordAgentStage(input: Parameters<WorkerMetricsSink['recordAgentStage']>[0]): void {
    const labels = { component: input.component, stage: input.stage };
    this.stageDuration.observe(labels, Math.max(0, input.durationMs) / 1_000);
    const counts = [
      ['input', input.inputCount],
      ['output', input.outputCount],
      ['failure', input.failureCount],
    ] as const;
    for (const [kind, count] of counts) {
      if (count !== undefined && count > 0) this.stageItems.inc({ ...labels, kind }, count);
    }
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}

export async function startWorkerMetricsServer(
  metrics: WorkerMetrics,
  port: number,
  host = '0.0.0.0',
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
      return;
    }
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404);
      response.end();
      return;
    }
    void metrics.render().then((body) => {
      response.writeHead(200, { 'content-type': metrics.contentType });
      response.end(body);
    }).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolvePromise);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}
