import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { restorePostgresBackupForVerification } from './postgres-backup.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const composePath = join(repositoryRoot, 'infra', 'compose.yaml');
const args = process.argv.slice(2);

const argument = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
};

const positionalBackup = args.find((value, index) => (
  !value.startsWith('--') && !['--backup', '--target-db'].includes(args[index - 1] ?? '')
));
const backup = argument('--backup') ?? positionalBackup;
if (!backup) throw new Error('A backup path is required');
const generatedTarget = `lettermate_restore_${new Date().toISOString()
  .replace(/[-:.]/g, '')
  .toLowerCase()}`;
const result = await restorePostgresBackupForVerification({
  composePath,
  dumpPath: resolve(backup),
  targetDatabase: argument('--target-db') ?? generatedTarget,
  keepDatabase: args.includes('--keep'),
});
console.log(JSON.stringify({ status: 'verified', ...result }));
