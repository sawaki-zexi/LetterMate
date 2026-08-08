import type { INestApplication } from '@nestjs/common';
import { writeOperationalLog, type OperationalLogger } from './observability.js';

export type ApiShutdownSignal = 'SIGINT' | 'SIGTERM';

export function createApiShutdown(
  app: Pick<INestApplication, 'close'>,
  logger: OperationalLogger = console,
): (signal: ApiShutdownSignal) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;

  return (signal) => {
    shutdownPromise ??= (async () => {
      try {
        writeOperationalLog(logger, { level: 'info', event: 'api.stopping', code: signal });
        await app.close();
        writeOperationalLog(logger, { level: 'info', event: 'api.stopped', code: signal });
      } catch {
        writeOperationalLog(logger, {
          level: 'error',
          event: 'api.shutdown.failed',
          code: 'API_SHUTDOWN_FAILED',
        });
        throw new Error('API shutdown failed');
      }
    })();
    return shutdownPromise;
  };
}
