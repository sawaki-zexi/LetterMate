import { describe, expect, it } from 'vitest';
import { ApiMetrics } from './metrics.js';

describe('API metrics', () => {
  it('records bounded route templates and status classes', async () => {
    const metrics = new ApiMetrics();
    metrics.recordRequest({
      method: 'get',
      route: '/api/v1/topics/:id',
      statusCode: 404,
      durationMs: 25,
    });

    const output = await metrics.render();
    expect(output).toContain(
      'lettermate_api_http_requests_total{method="GET",route="/api/v1/topics/:id",status_class="4xx"} 1',
    );
    expect(output).toContain('lettermate_api_http_request_duration_seconds_sum');
    expect(output).not.toContain('userId');
  });
});
