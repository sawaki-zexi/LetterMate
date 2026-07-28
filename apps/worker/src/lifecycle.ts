interface Closable {
  close(): void | Promise<unknown>;
}

export interface WorkerShutdownResources {
  schedulers: Closable[];
  workers: Closable[];
  queues: Closable[];
  redis: { quit(): Promise<unknown> };
  prisma: { $disconnect(): Promise<unknown> };
  logger?: { error(message: string): void };
}

const settlePhase = async (
  operations: Array<() => void | Promise<unknown>>,
  logger: { error(message: string): void },
  failureMessage: string,
): Promise<void> => {
  const results = await Promise.allSettled(
    operations.map(async (operation) => operation()),
  );
  if (results.some(({ status }) => status === 'rejected')) {
    logger.error(failureMessage);
  }
};

export function createWorkerShutdown(resources: WorkerShutdownResources): () => Promise<void> {
  const logger = resources.logger ?? console;
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    shutdownPromise ??= (async () => {
      await settlePhase(
        resources.schedulers.map((scheduler) => () => scheduler.close()),
        logger,
        'Worker scheduler shutdown encountered an error',
      );
      await settlePhase(
        resources.workers.map((worker) => () => worker.close()),
        logger,
        'Worker shutdown encountered an error',
      );
      await settlePhase(
        resources.queues.map((queue) => () => queue.close()),
        logger,
        'Worker queue shutdown encountered an error',
      );
      await settlePhase(
        [() => resources.redis.quit(), () => resources.prisma.$disconnect()],
        logger,
        'Worker resource shutdown encountered an error',
      );
    })();
    return shutdownPromise;
  };
}
