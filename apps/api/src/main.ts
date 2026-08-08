import 'reflect-metadata';
import { createApiApp } from './app.js';
import { createApiShutdown } from './lifecycle.js';
import { writeOperationalLog } from './observability.js';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const app = await createApiApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen(port, '0.0.0.0');
const shutdown = createApiShutdown(app);
const handleShutdown = (signal: 'SIGINT' | 'SIGTERM') => {
  void shutdown(signal).catch(() => { process.exitCode = 1; });
};
process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));
writeOperationalLog(console, {
  level: 'info',
  event: 'api.started',
});
