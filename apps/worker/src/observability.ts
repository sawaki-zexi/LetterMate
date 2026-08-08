import {
  operationalLogSchema,
  type AgentRunStage,
  type OperationalLog,
} from '@lettermate/contracts';
import type { Job, Worker } from 'bullmq';
import type { WorkerMetricsSink } from './metrics.js';

export interface OperationalLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface AgentStageTelemetry {
  runId: string;
  stage: AgentRunStage;
  durationMs: number;
  inputCount?: number;
  outputCount?: number;
  failureCount?: number;
}

interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

interface QueueMetricsSource {
  getJobCounts(...types: Array<keyof QueueCounts>): Promise<Record<string, number>>;
}

const boundedIdentifier = (value: unknown, maxLength: number): string | undefined => (
  typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined
);

const jobContext = (job: Job<unknown> | undefined): Pick<OperationalLog, 'runId' | 'jobId' | 'attempt'> => {
  const data = job?.data && typeof job.data === 'object' ? job.data as Record<string, unknown> : {};
  return {
    ...(boundedIdentifier(data.runId, 100) ? { runId: boundedIdentifier(data.runId, 100) } : {}),
    ...(boundedIdentifier(job?.id, 200) ? { jobId: boundedIdentifier(job?.id, 200) } : {}),
    ...(job ? { attempt: job.attemptsMade + 1 } : {}),
  };
};

const safeErrorCode = (error: unknown, fallback: string): string => {
  if (!error || typeof error !== 'object' || !('code' in error)) return fallback;
  const code = boundedIdentifier(error.code, 100);
  return code && /^[A-Z0-9_:-]+$/.test(code) ? code : fallback;
};

export function writeOperationalLog(
  logger: OperationalLogger,
  input: Omit<OperationalLog, 'timestamp' | 'service'>,
  now = new Date(),
): void {
  const entry = operationalLogSchema.parse({
    ...input,
    timestamp: now.toISOString(),
    service: 'worker',
  });
  const serialized = JSON.stringify(entry);
  if (entry.level === 'error') logger.error(serialized);
  else if (entry.level === 'warn') logger.warn(serialized);
  else logger.log(serialized);
}

export function writeAgentStageLog(
  logger: OperationalLogger,
  component: 'topic' | 'trend',
  telemetry: AgentStageTelemetry,
  now = new Date(),
  metrics?: WorkerMetricsSink,
): void {
  const { runId, stage, durationMs, inputCount, outputCount, failureCount } = telemetry;
  const aggregateCounts = { inputCount, outputCount, failureCount };
  const hasMetrics = Object.values(aggregateCounts).some((value) => value !== undefined);
  writeOperationalLog(logger, {
    level: 'info',
    event: 'agent.stage.completed',
    component,
    runId,
    stage,
    durationMs: Math.max(0, Math.floor(durationMs)),
    ...(hasMetrics ? { metrics: aggregateCounts } : {}),
  }, now);
  metrics?.recordAgentStage({ component, ...telemetry });
}

export function attachWorkerLogging<T>(
  worker: Worker<T>,
  queue: string,
  logger: OperationalLogger = console,
  now: () => Date = () => new Date(),
  metrics?: WorkerMetricsSink,
): void {
  worker.on('completed', (job) => {
    writeOperationalLog(logger, {
      level: 'info', event: 'queue.job.completed', queue, ...jobContext(job),
    }, now());
    metrics?.recordJob(queue, 'completed');
  });
  worker.on('failed', (job, error) => {
    const code = safeErrorCode(error, 'JOB_FAILED');
    writeOperationalLog(logger, {
      level: 'error', event: 'queue.job.failed', queue, ...jobContext(job), code,
    }, now());
    metrics?.recordJob(queue, 'failed', code);
  });
  worker.on('stalled', (jobId) => {
    writeOperationalLog(logger, {
      level: 'warn', event: 'queue.job.stalled', queue,
      ...(boundedIdentifier(jobId, 200) ? { jobId: boundedIdentifier(jobId, 200) } : {}),
      code: 'JOB_STALLED',
    }, now());
    metrics?.recordJob(queue, 'stalled', 'JOB_STALLED');
  });
  worker.on('error', (error) => {
    const code = safeErrorCode(error, 'WORKER_ERROR');
    writeOperationalLog(logger, {
      level: 'error', event: 'queue.worker.error', queue,
      code, dependency: 'redis',
    }, now());
    metrics?.recordJob(queue, 'worker_error', code);
  });
}

export function startQueueMetricsReporter(
  queue: string,
  source: QueueMetricsSource,
  options: {
    logger?: OperationalLogger;
    intervalMs?: number;
    now?: () => Date;
    metrics?: WorkerMetricsSink;
  } = {},
): { close(): void } {
  const logger = options.logger ?? console;
  const now = options.now ?? (() => new Date());
  let closed = false;
  let inFlight: Promise<void> | null = null;
  const scan = () => {
    if (closed || inFlight) return;
    const operation = source.getJobCounts('waiting', 'active', 'delayed', 'failed')
      .then((raw) => {
        const counts = {
          waiting: raw.waiting ?? 0,
          active: raw.active ?? 0,
          delayed: raw.delayed ?? 0,
          failed: raw.failed ?? 0,
        };
        writeOperationalLog(logger, {
          level: counts.failed > 0 ? 'warn' : 'info',
          event: 'queue.snapshot',
          queue,
          counts,
        }, now());
        options.metrics?.recordQueueSnapshot(queue, counts);
      })
      .catch(() => writeOperationalLog(logger, {
        level: 'error', event: 'queue.metrics.failed', queue,
        code: 'QUEUE_METRICS_UNAVAILABLE', dependency: 'redis',
      }, now()))
      .finally(() => { if (inFlight === operation) inFlight = null; });
    inFlight = operation;
  };
  scan();
  const timer = setInterval(scan, options.intervalMs ?? 60_000);
  timer.unref();
  return { close: () => { closed = true; clearInterval(timer); } };
}
