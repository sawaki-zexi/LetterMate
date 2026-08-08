import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  createDirectPostgresCommandRunner,
  postgresEnvironmentFromUrl,
  restorePostgresBackupForVerification,
} from './postgres-backup.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const composePath = join(repositoryRoot, 'infra', 'compose.yaml');
const args = process.argv.slice(2);

try {
  process.loadEnvFile(join(repositoryRoot, '.env'));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const argument = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
};

const positionalBackup = args.find((value, index) => (
  value !== 'direct'
    && !value.startsWith('--')
    && !['--backup', '--target-db'].includes(args[index - 1] ?? '')
));
const direct = args.includes('direct') || args.includes('--direct');
const backup = argument('--backup') ?? positionalBackup;
if (!backup) throw new Error('A backup path is required');
const generatedTarget = `lettermate_restore_${new Date().toISOString()
  .replace(/[-:.]/g, '')
  .toLowerCase()}`;
const databaseUrl = direct ? process.env.DATABASE_URL : undefined;
if (direct && !databaseUrl) throw new Error('DATABASE_URL is required in direct mode');
const postgresEnvironment = databaseUrl ? postgresEnvironmentFromUrl(databaseUrl) : undefined;
const result = await restorePostgresBackupForVerification({
  dumpPath: resolve(backup),
  targetDatabase: argument('--target-db') ?? generatedTarget,
  keepDatabase: args.includes('--keep'),
  ...(databaseUrl ? {
    runner: createDirectPostgresCommandRunner(databaseUrl),
    user: postgresEnvironment?.PGUSER ?? 'lettermate',
  } : { composePath }),
});
console.log(JSON.stringify({ status: 'verified', ...result }));
