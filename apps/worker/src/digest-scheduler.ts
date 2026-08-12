import type { DigestJobData } from '@lettermate/contracts';
import type { DigestScheduleRepository } from './digest-service.js';
import { RuntimeDependencyError, toSafeRuntimeFailure } from './runtime-health.js';

interface DigestQueue {
  add(name: string, data: DigestJobData, options: {
    jobId: string;
    attempts: number;
    backoff: { type: string };
    removeOnComplete: boolean;
    removeOnFail: boolean;
  }): Promise<unknown>;
}

export function localDigestClock(now: Date, timezone: string): {
  localDate: string;
  localTime: string;
} {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return {
    localDate: `${values.year}-${values.month}-${values.day}`,
    localTime: `${values.hour}:${values.minute}`,
  };
}

export class DigestScheduleService {
  constructor(
    private readonly repository: DigestScheduleRepository,
    private readonly queue: DigestQueue,
  ) {}

  async scan(now = new Date()): Promise<number> {
    let preferences;
    try {
      preferences = await this.repository.listEnabledPreferences();
    } catch {
      throw new RuntimeDependencyError(
        'DIGEST_SCHEDULER_DATABASE_UNAVAILABLE',
        'database',
        'Digest scheduler could not read enabled preferences',
      );
    }
    const prepared = [];
    for (const preference of preferences) {
      const clock = localDigestClock(now, preference.timezone);
      if (clock.localTime < preference.localTime) continue;
      try {
        const run = await this.repository.ensureRun({
          userId: preference.userId,
          recipientEmail: preference.recipientEmail,
          unsubscribeTokenId: preference.unsubscribeTokenId,
          scheduledLocalDate: clock.localDate,
          windowEnd: now,
          now,
        });
        if (run?.status === 'queued') prepared.push(run);
      } catch {
        throw new RuntimeDependencyError(
          'DIGEST_SCHEDULER_DATABASE_UNAVAILABLE',
          'database',
          'Digest scheduler could not prepare a due run',
        );
      }
    }
    try {
      await Promise.all(prepared.map((run) => this.queue.add(
        'deliver-digest',
        { runId: run.runId, userId: run.userId },
        {
          jobId: `digest-${run.runId}`,
          attempts: 4,
          backoff: { type: 'digest' },
          removeOnComplete: true,
          removeOnFail: true,
        },
      )));
    } catch {
      throw new RuntimeDependencyError(
        'DIGEST_SCHEDULER_REDIS_UNAVAILABLE',
        'redis',
        'Digest scheduler could not enqueue prepared runs',
      );
    }
    return prepared.length;
  }
}

export function startDigestScheduler(
  service: Pick<DigestScheduleService, 'scan'>,
  options: {
    intervalMs?: number;
    logger?: { error(message: string): void };
  } = {},
): { close(): Promise<void> } {
  const logger = options.logger ?? console;
  let closing = false;
  let inFlight: Promise<void> | null = null;
  const scan = () => {
    if (closing || inFlight !== null) return;
    const run = Promise.resolve()
      .then(() => service.scan())
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error(JSON.stringify(toSafeRuntimeFailure(
          error,
          'DIGEST_SCHEDULER_SCAN_FAILED',
          'database',
        )));
      });
    const tracked = run.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
  };
  scan();
  const timer = setInterval(scan, options.intervalMs ?? 5 * 60_000);
  timer.unref();
  return {
    close: () => {
      closing = true;
      clearInterval(timer);
      return inFlight ?? Promise.resolve();
    },
  };
}
