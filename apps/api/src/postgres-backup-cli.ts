import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  createPostgresBackup,
  verifyBackup,
} from './postgres-backup.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const composePath = join(repositoryRoot, 'infra', 'compose.yaml');
const backupDirectory = join(repositoryRoot, '.backups', 'postgres');
const args = process.argv.slice(2);

const argument = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
};

const positionalBackup = args.find((value, index) => (
  !value.startsWith('--') && args[index - 1] !== '--backup'
));

if (args.includes('--verify')) {
  const backup = argument('--backup') ?? positionalBackup;
  if (!backup) throw new Error('A backup path is required with --verify');
  const manifest = await verifyBackup(resolve(backup));
  console.log(JSON.stringify({ status: 'verified', manifest }));
} else {
  const result = await createPostgresBackup({
    composePath,
    backupDirectory,
    prune: !args.includes('--no-prune'),
  });
  console.log(JSON.stringify({
    status: 'created',
    backup: result.dumpPath,
    manifest: result.manifestPath,
    bytes: result.manifest.bytes,
    sha256: result.manifest.sha256,
  }));
}
