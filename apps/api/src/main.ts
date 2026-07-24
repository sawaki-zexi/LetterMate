import 'reflect-metadata';
import { createApiApp } from './app.js';

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const app = await createApiApp();
await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
