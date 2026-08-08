import { parseConfig } from '@lettermate/config';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import {
  configurationFailureReport,
  doctorLiveModeFromArgs,
  runOperationalDoctor,
  type DoctorProbe,
} from './ops-doctor.js';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const live = doctorLiveModeFromArgs(process.argv.slice(2));

try {
  const config = parseConfig(process.env);
  let databaseProbe: DoctorProbe | undefined;
  let redisProbe: DoctorProbe | undefined;

  if (live) {
    const prisma = new PrismaClient();
    const redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 5_000,
      maxRetriesPerRequest: 0,
    });
    redis.on('error', () => {});
    databaseProbe = {
      check: async () => { await prisma.$queryRaw`SELECT 1`; },
      close: () => prisma.$disconnect(),
    };
    redisProbe = {
      check: async () => {
        if (redis.status === 'wait') await redis.connect();
        if (await redis.ping() !== 'PONG') throw new Error('Redis ping failed');
      },
      close: () => redis.disconnect(),
    };
  }

  const report = await runOperationalDoctor(config, {
    live,
    ...(databaseProbe ? { databaseProbe } : {}),
    ...(redisProbe ? { redisProbe } : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'error') process.exitCode = 1;
} catch {
  process.stdout.write(`${JSON.stringify(configurationFailureReport(), null, 2)}\n`);
  process.exitCode = 1;
}
