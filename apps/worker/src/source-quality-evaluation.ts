import {
  evaluateSourceQuality,
  type SourceQualityEvaluationReport,
  type SourceQualityFunnelInput,
} from '@lettermate/domain';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const vectorResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('vector'),
    result: z.array(z.object({
      metric: z.record(z.string(), z.string()),
      value: z.tuple([z.number(), z.string()]),
    })),
  }),
});

const matrixResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z.array(z.object({
      metric: z.record(z.string(), z.string()),
      values: z.array(z.tuple([z.number(), z.string()])),
    })),
  }),
});

interface MutableSourceFunnel {
  source: string;
  sourceType: string;
  successfulAttempts: number;
  failedAttempts: number;
  failureCodes: Record<string, number>;
  outcomes: Record<string, number>;
}

export interface SourceQualityCliOptions {
  prometheusUrl: string;
  hours: number;
}

const parseHours = (value: string | undefined): number => {
  if (value === undefined) return 24;
  const hours = Number(value);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
    throw new Error('hours must be an integer between 1 and 168');
  }
  return hours;
};

const normalizePrometheusUrl = (value: string | undefined): string => {
  const url = new URL(value?.trim() || 'http://127.0.0.1:9090');
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Prometheus URL must use HTTP(S) without embedded credentials');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
};

export function parseSourceQualityCliOptions(
  urlValue: string | undefined,
  hoursValue: string | undefined,
): SourceQualityCliOptions {
  return {
    prometheusUrl: normalizePrometheusUrl(urlValue),
    hours: parseHours(hoursValue),
  };
}

const endpoint = (baseUrl: string, path: string): URL => {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  url.search = '';
  return url;
};

const readJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error(`Prometheus request failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('Prometheus returned an invalid JSON response');
  }
};

const metricValue = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Prometheus returned an invalid metric value');
  }
  return parsed;
};

export async function readSourceQualityReport(input: {
  prometheusUrl: string;
  hours: number;
  now?: Date;
  fetcher?: typeof fetch;
}): Promise<SourceQualityEvaluationReport> {
  const { prometheusUrl, hours } = parseSourceQualityCliOptions(
    input.prometheusUrl,
    String(input.hours),
  );
  const fetcher = input.fetcher ?? fetch;
  const windowEnd = input.now ?? new Date();
  const windowStart = new Date(windowEnd.getTime() - hours * 60 * 60 * 1_000);
  const duration = `${hours}h`;
  const attemptsUrl = endpoint(prometheusUrl, '/api/v1/query');
  attemptsUrl.searchParams.set('query', `sum by (source, source_type, result, code) (increase(lettermate_worker_source_attempts_total[${duration}]))`);
  attemptsUrl.searchParams.set('time', String(windowEnd.getTime() / 1_000));
  const itemsUrl = endpoint(prometheusUrl, '/api/v1/query');
  itemsUrl.searchParams.set('query', `sum by (source, source_type, outcome) (increase(lettermate_worker_source_items_total[${duration}]))`);
  itemsUrl.searchParams.set('time', String(windowEnd.getTime() / 1_000));
  const uptimeUrl = endpoint(prometheusUrl, '/api/v1/query_range');
  uptimeUrl.searchParams.set('query', 'max(up{job="lettermate-worker"})');
  uptimeUrl.searchParams.set('start', String(windowStart.getTime() / 1_000));
  uptimeUrl.searchParams.set('end', String(windowEnd.getTime() / 1_000));
  uptimeUrl.searchParams.set('step', '60');

  const request = async (url: URL): Promise<Response> => {
    try {
      return await fetcher(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new Error('Prometheus request timed out');
      }
      throw new Error('Prometheus is unavailable');
    }
  };
  const [attemptsPayload, itemsPayload, uptimePayload] = await Promise.all([
    request(attemptsUrl).then(readJson),
    request(itemsUrl).then(readJson),
    request(uptimeUrl).then(readJson),
  ]);
  const attempts = vectorResponseSchema.safeParse(attemptsPayload);
  const items = vectorResponseSchema.safeParse(itemsPayload);
  const uptime = matrixResponseSchema.safeParse(uptimePayload);
  if (!attempts.success || !items.success || !uptime.success) {
    throw new Error('Prometheus returned an unexpected query response');
  }

  const funnels = new Map<string, MutableSourceFunnel>();
  const getFunnel = (metric: Record<string, string>): MutableSourceFunnel => {
    const source = metric.source?.trim();
    const sourceType = metric.source_type?.trim();
    if (!source || !sourceType) throw new Error('Prometheus source metrics are missing bounded labels');
    const key = `${source}\u0000${sourceType}`;
    const existing = funnels.get(key);
    if (existing) return existing;
    const created: MutableSourceFunnel = {
      source,
      sourceType,
      successfulAttempts: 0,
      failedAttempts: 0,
      failureCodes: {},
      outcomes: {},
    };
    funnels.set(key, created);
    return created;
  };
  for (const sample of attempts.data.data.result) {
    const funnel = getFunnel(sample.metric);
    const value = metricValue(sample.value[1]);
    if (sample.metric.result === 'success') funnel.successfulAttempts += value;
    else if (sample.metric.result === 'failure') {
      funnel.failedAttempts += value;
      const code = sample.metric.code?.trim();
      if (code && code !== 'none') funnel.failureCodes[code] = (funnel.failureCodes[code] ?? 0) + value;
    }
  }
  for (const sample of items.data.data.result) {
    const funnel = getFunnel(sample.metric);
    const outcome = sample.metric.outcome?.trim();
    if (!outcome) throw new Error('Prometheus source item metrics are missing an outcome');
    funnel.outcomes[outcome] = (funnel.outcomes[outcome] ?? 0) + metricValue(sample.value[1]);
  }
  const uptimeValues = uptime.data.data.result[0]?.values ?? [];
  const expectedSampleCount = Math.floor(
    (windowEnd.getTime() - windowStart.getTime()) / 60_000,
  ) + 1;
  const sources: SourceQualityFunnelInput[] = [...funnels.values()];
  return evaluateSourceQuality({
    windowStart,
    windowEnd,
    observation: {
      expectedSampleCount,
      observedSampleCount: uptimeValues.length,
      healthySampleCount: uptimeValues.filter((value) => metricValue(value[1]) >= 1).length,
    },
    sources,
  });
}

async function main(): Promise<void> {
  try { process.loadEnvFile(new URL('../../../.env', import.meta.url)); } catch { /* optional */ }
  const options = parseSourceQualityCliOptions(
    process.argv[2] ?? process.env.PROMETHEUS_URL,
    process.argv[3],
  );
  const report = await readSourceQualityReport(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
