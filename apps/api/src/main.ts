import 'reflect-metadata';
import { createApiApp } from './app.js';

const app = await createApiApp();
await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
