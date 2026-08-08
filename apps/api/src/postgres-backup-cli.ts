import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  createDirectPostgresCommandRunner,
  createPostgresBackup,
  postgresEnvironmentFromUrl,
  verifyBackup,
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
  value !== 'direct' && !value.startsWith('--') && args[index - 1] !== '--backup'
));
const direct = args.includes('direct') || args.includes('--direct');
const backupDirectory = resolve(
  argument('--directory') ?? process.env.BACKUP_DIRECTORY
    ?? join(repositoryRoot, '.backups', 'postgres'),
);

if (args.includes('--verify')) {
  const backup = argument('--backup') ?? positionalBackup;
  if (!backup) throw new Error('A backup path is required with --verify');
  const manifest = await verifyBackup(resolve(backup));
  console.log(JSON.stringify({ status: 'verified', manifest }));
} else {
  const databaseUrl = direct ? process.env.DATABASE_URL : undefined;
  if (direct && !databaseUrl) throw new Error('DATABASE_URL is required in direct mode');
  const postgresEnvironment = databaseUrl ? postgresEnvironmentFromUrl(databaseUrl) : undefined;
  const result = await createPostgresBackup({
    backupDirectory,
    database: postgresEnvironment?.PGDATABASE ?? process.env.POSTGRES_DB ?? 'lettermate',
    prune: !args.includes('--no-prune'),
    ...(databaseUrl ? {
      runner: createDirectPostgresCommandRunner(databaseUrl),
      user: postgresEnvironment?.PGUSER ?? 'lettermate',
    } : { composePath }),
  });
  console.log(JSON.stringify({
    status: 'created',
    backup: result.dumpPath,
    manifest: result.manifestPath,
    bytes: result.manifest.bytes,
    sha256: result.manifest.sha256,
  }));
}
