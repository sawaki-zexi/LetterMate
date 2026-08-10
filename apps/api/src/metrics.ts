import { Counter, Histogram, Registry } from 'prom-client';

export interface ApiRequestMetric {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

export interface ApiRequestMetricsSink {
  recordRequest(metric: ApiRequestMetric): void;
}

export interface FeedImpressionMetrics {
  status: 'accepted' | 'rejected';
  recorded: number;
}

const statusClass = (statusCode: number): string => `${Math.floor(statusCode / 100)}xx`;

export class ApiMetrics implements ApiRequestMetricsSink {
  readonly registry = new Registry();
  private readonly requestCount = new Counter({
    name: 'lettermate_api_http_requests_total',
    help: 'Completed LetterMate API requests.',
    labelNames: ['method', 'route', 'status_class'] as const,
    registers: [this.registry],
  });
  private readonly requestDuration = new Histogram({
    name: 'lettermate_api_http_request_duration_seconds',
    help: 'LetterMate API request duration in seconds.',
    labelNames: ['method', 'route', 'status_class'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly impressionBatches = new Counter({
    name: 'lettermate_api_feed_impression_batches_total',
    help: 'Feed impression batches accepted or rejected by the API.',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  private readonly impressions = new Counter({
    name: 'lettermate_api_feed_impressions_total',
    help: 'Feed impressions recorded by the API.',
    registers: [this.registry],
  });

  recordRequest(metric: ApiRequestMetric): void {
    const labels = {
      method: metric.method.toUpperCase().slice(0, 20),
      route: metric.route.slice(0, 200),
      status_class: statusClass(metric.statusCode),
    };
    this.requestCount.inc(labels);
    this.requestDuration.observe(labels, Math.max(0, metric.durationMs) / 1_000);
  }

  recordFeedImpression(input: FeedImpressionMetrics): void {
    this.impressionBatches.inc({ status: input.status });
    if (input.recorded > 0) this.impressions.inc(input.recorded);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
