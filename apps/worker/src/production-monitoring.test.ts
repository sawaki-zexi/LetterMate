import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface ComposeService {
  profiles?: string[];
  image?: string;
  command?: string[];
  volumes?: string[];
  ports?: string[];
  extra_hosts?: string[];
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
}

interface PrometheusScrapeConfig {
  job_name: string;
  metrics_path?: string;
  static_configs: Array<{ targets: string[] }>;
}

interface PrometheusConfig {
  rule_files: string[];
  scrape_configs: PrometheusScrapeConfig[];
}

interface AlertRule {
  alert: string;
  expr: string;
  for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

interface AlertConfig {
  groups: Array<{ name: string; rules: AlertRule[] }>;
}

const monitoringDirectory = join(process.cwd(), 'infra', 'monitoring');
const compose = parse(readFileSync(
  join(process.cwd(), 'infra', 'compose.production.example.yaml'),
  'utf8',
)) as ComposeConfig;
const localCompose = parse(readFileSync(
  join(process.cwd(), 'infra', 'compose.yaml'),
  'utf8',
)) as ComposeConfig;
const prometheus = parse(readFileSync(
  join(monitoringDirectory, 'prometheus.yml'),
  'utf8',
)) as PrometheusConfig;
const localPrometheus = parse(readFileSync(
  join(monitoringDirectory, 'prometheus.local.yml'),
  'utf8',
)) as PrometheusConfig;
const alerts = parse(readFileSync(
  join(monitoringDirectory, 'alerts.yml'),
  'utf8',
)) as AlertConfig;

describe('production monitoring configuration', () => {
  it('keeps Prometheus opt-in, pinned, persistent, and loopback-only by default', () => {
    const service = compose.services.prometheus;

    expect(service).toBeDefined();
    expect(service?.profiles).toEqual(['monitoring']);
    expect(service?.image).toMatch(/^prom\/prometheus:v\d+\.\d+\.\d+$/);
    expect(service?.command).toEqual(expect.arrayContaining([
      '--config.file=/etc/prometheus/prometheus.yml',
      '--storage.tsdb.path=/prometheus',
    ]));
    expect(service?.volumes).toEqual(expect.arrayContaining([
      './monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro',
      './monitoring/alerts.yml:/etc/prometheus/alerts.yml:ro',
      'lettermate-prometheus:/prometheus',
    ]));
    expect(service?.ports).toEqual([
      '${PROMETHEUS_BIND_ADDRESS:-127.0.0.1}:${PROMETHEUS_PORT:-9090}:9090',
    ]);
    expect(compose.volumes).toHaveProperty('lettermate-prometheus');
    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.redis?.ports).toBeUndefined();
  });

  it('scrapes the internal API and Worker metrics endpoints', () => {
    expect(prometheus.rule_files).toEqual(['/etc/prometheus/alerts.yml']);
    expect(prometheus.scrape_configs).toEqual([
      {
        job_name: 'lettermate-api',
        metrics_path: '/metrics',
        static_configs: [{ targets: ['api:3000'] }],
      },
      {
        job_name: 'lettermate-worker',
        metrics_path: '/metrics',
        static_configs: [{ targets: ['worker:9464'] }],
      },
    ]);
  });

  it('provides opt-in persistent monitoring for host-run local services', () => {
    const service = localCompose.services.prometheus;

    expect(service).toBeDefined();
    expect(service?.profiles).toEqual(['monitoring']);
    expect(service?.image).toBe('prom/prometheus:v3.5.0');
    expect(service?.extra_hosts).toEqual(['host.docker.internal:host-gateway']);
    expect(service?.command).toEqual(expect.arrayContaining([
      '--config.file=/etc/prometheus/prometheus.yml',
      '--storage.tsdb.path=/prometheus',
      '--storage.tsdb.retention.time=15d',
    ]));
    expect(service?.volumes).toEqual(expect.arrayContaining([
      './monitoring/prometheus.local.yml:/etc/prometheus/prometheus.yml:ro',
      './monitoring/alerts.yml:/etc/prometheus/alerts.yml:ro',
      'lettermate-prometheus:/prometheus',
    ]));
    expect(service?.ports).toEqual([
      '${PROMETHEUS_BIND_ADDRESS:-127.0.0.1}:${PROMETHEUS_PORT:-9090}:9090',
    ]);
    expect(localCompose.volumes).toHaveProperty('lettermate-prometheus');
    expect(localPrometheus.rule_files).toEqual(['/etc/prometheus/alerts.yml']);
    expect(localPrometheus.scrape_configs).toEqual([
      {
        job_name: 'lettermate-api',
        metrics_path: '/metrics',
        static_configs: [{ targets: ['host.docker.internal:3000'] }],
      },
      {
        job_name: 'lettermate-worker',
        metrics_path: '/metrics',
        static_configs: [{ targets: ['host.docker.internal:9464'] }],
      },
    ]);
  });

  it('defines the required availability, failure, backlog, and latency alerts', () => {
    const rules = alerts.groups.flatMap((group) => group.rules);
    const names = rules.map((rule) => rule.alert);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'LetterMateApiMetricsDown',
      'LetterMateWorkerMetricsDown',
      'LetterMateApiHighErrorRatio',
      'LetterMateFeedImpressionRejected',
      'LetterMateQueueFailedJobs',
      'LetterMateQueueBacklog',
      'LetterMateWorkerJobFailures',
      'LetterMateAgentStageSlow',
      'LetterMateSourceRepeatedFailures',
      'LetterMateSourceNoCandidates',
      'LetterMateSourceLowAcceptanceYield',
      'LetterMateSingleSourceDominance',
    ]));
    expect(rules.every((rule) => ['critical', 'high', 'medium'].includes(
      rule.labels.severity ?? '',
    ))).toBe(true);
    expect(rules.every((rule) => typeof rule.annotations.summary === 'string')).toBe(true);
  });

  it('uses only exported metrics and bounded label dimensions in alert expressions', () => {
    const allowedMetrics = new Set([
      'up',
      'lettermate_api_http_requests_total',
      'lettermate_api_feed_impression_batches_total',
      'lettermate_worker_queue_jobs',
      'lettermate_worker_job_events_total',
      'lettermate_worker_agent_stage_duration_seconds_bucket',
      'lettermate_worker_source_attempts_total',
      'lettermate_worker_source_items_total',
    ]);
    const allowedLabels = new Set([
      'job', 'status', 'status_class', 'queue', 'state', 'result', 'code', 'component', 'stage', 'le',
      'source', 'source_type', 'outcome',
    ]);
    const forbiddenFragments = [
      'user', 'email', 'keyword', 'url', 'trace', 'run_id', 'job_id', 'source_id',
    ];

    for (const rule of alerts.groups.flatMap((group) => group.rules)) {
      const metrics = rule.expr.match(/\b(?:up|lettermate_[a-z0-9_:]+)\b/g) ?? [];
      expect(metrics.length, `${rule.alert} must reference a LetterMate metric`).toBeGreaterThan(0);
      expect(metrics.every((metric) => allowedMetrics.has(metric))).toBe(true);

      const selectors = [...rule.expr.matchAll(/\{([^}]*)\}/g)]
        .flatMap((match) => [...match[1]!.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|!=|=~|!~)/g)])
        .map((match) => match[1]!);
      const groupings = [...rule.expr.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)]
        .flatMap((match) => match[1]!.split(',').map((label) => label.trim()));
      expect([...selectors, ...groupings].every((label) => allowedLabels.has(label))).toBe(true);

      const normalized = rule.expr.toLowerCase();
      expect(forbiddenFragments.some((fragment) => normalized.includes(fragment))).toBe(false);
      expect(Object.keys(rule.labels)).toEqual(['severity']);
      expect(Object.values(rule.annotations).some((value) => value.includes('{{'))).toBe(false);
    }
  });
});
