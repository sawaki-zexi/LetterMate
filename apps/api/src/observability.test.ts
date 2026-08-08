import { describe, expect, it, vi } from 'vitest';
import { createRequestTracingMiddleware, currentTraceId, selectTraceId } from './observability.js';
import type { NextFunction, Request, Response } from 'express';

describe('API observability', () => {
  it('keeps a validated inbound trace ID in async request context and safe JSON logs', async () => {
    const finishListeners: Array<() => void> = [];
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const request = {
      headers: { 'x-trace-id': 'trace-123' },
      method: 'post',
      path: '/api/v1/topics',
      route: { path: '/api/v1/topics' },
    } as unknown as Request;
    const response = {
      statusCode: 201,
      setHeader: vi.fn(),
      once: (_event: string, listener: () => void) => { finishListeners.push(listener); },
    } as unknown as Response;
    let traceInHandler = '';
    const metrics = { recordRequest: vi.fn() };
    const next = (() => { traceInHandler = currentTraceId(); }) as NextFunction;

    createRequestTracingMiddleware(
      logger,
      () => new Date('2026-08-08T08:00:00.000Z'),
      metrics,
    )(
      request,
      response,
      next,
    );
    finishListeners[0]?.();

    expect(traceInHandler).toBe('trace-123');
    expect(response.setHeader).toHaveBeenCalledWith('x-trace-id', 'trace-123');
    expect(JSON.parse(logger.log.mock.calls[0]?.[0] as string)).toMatchObject({
      service: 'api', event: 'request.completed', traceId: 'trace-123', statusCode: 201,
    });
    expect(metrics.recordRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'post', route: '/api/v1/topics', statusCode: 201,
    }));
  });

  it('rejects unsafe inbound trace values', () => {
    expect(selectTraceId('trace-123')).toBe('trace-123');
    expect(selectTraceId('student@example.com secret')).not.toBe('student@example.com secret');
  });
});
