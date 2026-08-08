import { operationalLogSchema, type OperationalLog } from '@lettermate/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ApiRequestMetricsSink } from './metrics.js';

const traceStorage = new AsyncLocalStorage<{ traceId: string }>();
const traceIdPattern = /^[A-Za-z0-9._:-]{1,100}$/;

export interface OperationalLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const currentTraceId = (): string => traceStorage.getStore()?.traceId ?? randomUUID();

export const selectTraceId = (header: string | string[] | undefined): string => {
  const value = Array.isArray(header) ? header[0] : header;
  return value && traceIdPattern.test(value) ? value : randomUUID();
};

export function writeOperationalLog(
  logger: OperationalLogger,
  input: Omit<OperationalLog, 'timestamp' | 'service'>,
  now = new Date(),
): void {
  const entry = operationalLogSchema.parse({
    ...input,
    timestamp: now.toISOString(),
    service: 'api',
  });
  const serialized = JSON.stringify(entry);
  if (entry.level === 'error') logger.error(serialized);
  else if (entry.level === 'warn') logger.warn(serialized);
  else logger.log(serialized);
}

export function createRequestTracingMiddleware(
  logger?: OperationalLogger,
  now: () => Date = () => new Date(),
  metrics?: ApiRequestMetricsSink,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    const traceId = selectTraceId(request.headers['x-trace-id']);
    const startedAt = Date.now();
    response.setHeader('x-trace-id', traceId);
    response.once('finish', () => {
      const statusCode = response.statusCode;
      const routePath = request.route && typeof request.route.path === 'string'
        ? request.route.path
        : 'unmatched';
      const durationMs = Math.max(0, Date.now() - startedAt);
      metrics?.recordRequest({
        method: request.method,
        route: routePath,
        statusCode,
        durationMs,
      });
      if (!logger) return;
      writeOperationalLog(logger, {
        level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
        event: 'request.completed',
        traceId,
        method: request.method.toUpperCase(),
        path: request.path,
        statusCode,
        durationMs,
      }, now());
    });
    traceStorage.run({ traceId }, next);
  };
}
