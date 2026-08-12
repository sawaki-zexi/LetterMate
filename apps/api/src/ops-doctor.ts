import { isEmailDeliveryConfigured, type AppConfig } from '@lettermate/config';
import { configuredDiscoverySources } from './discovery-sources.js';

export type DoctorCheckStatus = 'ok' | 'warning' | 'error' | 'not_configured';

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  code?: string;
  details?: Record<string, string | number | boolean>;
}

export interface DoctorSourceStatus {
  id: string;
  status: 'enabled' | 'not_configured';
}

export interface OperationalDoctorReport {
  status: 'ok' | 'warning' | 'error';
  timestamp: string;
  mode: 'configuration' | 'live';
  checks: DoctorCheck[];
  sources: DoctorSourceStatus[];
}

export interface DoctorProbe {
  check(): Promise<void>;
  close(): void | Promise<void>;
}

export interface OperationalDoctorOptions {
  live?: boolean;
  databaseProbe?: DoctorProbe;
  redisProbe?: DoctorProbe;
  now?: () => Date;
}

export const doctorLiveModeFromArgs = (args: string[]): boolean => (
  args.includes('live') || args.includes('--live')
);

const reportStatus = (checks: DoctorCheck[]): OperationalDoctorReport['status'] => {
  if (checks.some((check) => check.status === 'error')) return 'error';
  if (checks.some((check) => check.status === 'warning')) return 'warning';
  return 'ok';
};

async function runDependencyProbe(
  id: 'database' | 'redis',
  probe: DoctorProbe | undefined,
): Promise<DoctorCheck> {
  if (!probe) return { id, status: 'error', code: 'DEPENDENCY_PROBE_NOT_CONFIGURED' };
  let failed = false;
  try {
    await probe.check();
  } catch {
    failed = true;
  }
  try {
    await probe.close();
  } catch {
    failed = true;
  }
  return failed
    ? { id, status: 'error', code: `${id.toUpperCase()}_UNAVAILABLE` }
    : { id, status: 'ok' };
}

export async function runOperationalDoctor(
  config: AppConfig,
  options: OperationalDoctorOptions = {},
): Promise<OperationalDoctorReport> {
  const live = options.live ?? false;
  const sources = configuredDiscoverySources(config).map(({ id, status }) => ({ id, status }));
  const enabledSourceCount = sources.filter((source) => source.status === 'enabled').length;
  const checks: DoctorCheck[] = [
    {
      id: 'configuration',
      status: 'ok',
      details: { environment: config.NODE_ENV },
    },
    config.ALLOW_DEV_IDENTITY
      ? { id: 'identity', status: 'warning', code: 'DEVELOPMENT_IDENTITY_ENABLED' }
      : { id: 'identity', status: 'ok' },
    new URL(config.WEB_ORIGIN).protocol === 'https:'
      ? { id: 'web-origin', status: 'ok' }
      : { id: 'web-origin', status: 'warning', code: 'HTTPS_NOT_CONFIGURED' },
    config.AI_API_KEY
      ? { id: 'ai', status: 'ok' }
      : { id: 'ai', status: 'not_configured', code: 'AI_NOT_CONFIGURED' },
    isEmailDeliveryConfigured(config)
      ? { id: 'email', status: 'ok', details: { provider: config.EMAIL_PROVIDER } }
      : { id: 'email', status: 'not_configured', code: 'EMAIL_NOT_CONFIGURED' },
    {
      id: 'sources',
      status: enabledSourceCount > 0 ? 'ok' : 'warning',
      ...(enabledSourceCount > 0 ? {} : { code: 'NO_DISCOVERY_SOURCE_ENABLED' }),
      details: {
        enabled: enabledSourceCount,
        notConfigured: sources.length - enabledSourceCount,
      },
    },
  ];

  if (live) {
    checks.push(...await Promise.all([
      runDependencyProbe('database', options.databaseProbe),
      runDependencyProbe('redis', options.redisProbe),
    ]));
  } else {
    checks.push(
      { id: 'database', status: 'ok', code: 'CONFIGURATION_PRESENT' },
      { id: 'redis', status: 'ok', code: 'CONFIGURATION_PRESENT' },
    );
  }

  return {
    status: reportStatus(checks),
    timestamp: (options.now?.() ?? new Date()).toISOString(),
    mode: live ? 'live' : 'configuration',
    checks,
    sources,
  };
}

export function configurationFailureReport(now = new Date()): OperationalDoctorReport {
  return {
    status: 'error',
    timestamp: now.toISOString(),
    mode: 'configuration',
    checks: [{ id: 'configuration', status: 'error', code: 'CONFIGURATION_INVALID' }],
    sources: [],
  };
}
