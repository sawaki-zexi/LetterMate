import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

const dayMs = 24 * 60 * 60 * 1_000;
const dumpNamePattern = /^lettermate-(\d{8}T\d{6}Z)\.dump$/;
const databaseNamePattern = /^[a-z][a-z0-9_]{0,62}$/;
const backupDatabaseNameSchema = z.string().trim().min(1).max(63)
  .refine((value) => (
    !/[\\/]/u.test(value)
    && [...value].every((character) => character.charCodeAt(0) >= 32)
  ), 'Backup database name is invalid');

export const backupRetentionPolicy = {
  dailyDays: 14,
  weeklyWeeks: 8,
  monthlyMonths: 12,
} as const;

const backupManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  database: backupDatabaseNameSchema,
  format: z.literal('postgres-custom'),
  fileName: z.string().regex(dumpNamePattern),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

interface BackupRecord {
  manifest: BackupManifest;
  manifestPath: string;
  dumpPath: string;
}

interface DockerOptions {
  composePath?: string;
  service?: string;
  user?: string;
  runner?: PostgresCommandRunner;
}

type ResolvedDockerOptions = Omit<DockerOptions, 'composePath' | 'runner'> & {
  composePath: string;
};

export interface PostgresCommandRunner {
  writeToFile(command: string[], outputPath: string, operation: string): Promise<void>;
  execute(command: string[], operation: string, inputPath?: string): Promise<string>;
}

export interface CreateBackupOptions extends DockerOptions {
  backupDirectory: string;
  database?: string;
  now?: Date;
  prune?: boolean;
}

export interface RestoreDrillOptions extends DockerOptions {
  dumpPath: string;
  targetDatabase: string;
  keepDatabase?: boolean;
}

export interface RestoreDrillResult {
  targetDatabase: string;
  tableCount: number;
  migrationCount: number;
  kept: boolean;
}

const safeChildPath = (directory: string, fileName: string): string => {
  const root = resolve(directory);
  const target = resolve(root, fileName);
  if (dirname(target) !== root || basename(target) !== fileName) {
    throw new Error('Backup path escaped the configured backup directory');
  }
  return target;
};

const manifestName = (dumpFileName: string): string => dumpFileName.replace(/\.dump$/, '.manifest.json');

const timestampForFile = (now: Date): string => now.toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}Z$/, 'Z');

export const createBackupFileName = (now: Date): string => `lettermate-${timestampForFile(now)}.dump`;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const collectStream = (stream: NodeJS.ReadableStream, maxBytes = 64_000): Promise<string> => (
  new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on('data', (chunk: Buffer | string) => {
      if (bytes >= maxBytes) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      chunks.push(buffer.subarray(0, remaining));
      bytes += Math.min(buffer.length, remaining);
    });
    stream.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolvePromise(''));
  })
);

const commandFailure = (operation: string, exitCode: number | null): Error => (
  new Error(`${operation} failed with exit code ${exitCode ?? 'unknown'}`)
);

async function dockerToFile(
  docker: ResolvedDockerOptions,
  command: string[],
  outputPath: string,
  operation: string,
): Promise<void> {
  const child = spawn('docker', [
    'compose', '-f', docker.composePath, 'exec', '-T',
    docker.service ?? 'postgres', ...command,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = collectStream(child.stderr);
  const exit = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(outputPath, { flags: 'wx' })),
    stderr,
    exit.then((code) => { if (code !== 0) throw commandFailure(operation, code); }),
  ]);
}

async function dockerCommand(
  docker: ResolvedDockerOptions,
  command: string[],
  operation: string,
  inputPath?: string,
): Promise<string> {
  const child = spawn('docker', [
    'compose', '-f', docker.composePath, 'exec', '-T',
    docker.service ?? 'postgres', ...command,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = collectStream(child.stdout);
  const stderr = collectStream(child.stderr);
  const exit = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  const input = inputPath
    ? pipeline(createReadStream(inputPath), child.stdin)
    : Promise.resolve(child.stdin.end());
  const [output, , exitCode] = await Promise.all([stdout, stderr, exit, input]);
  if (exitCode !== 0) throw commandFailure(operation, exitCode);
  return output.trim();
}

export function createDockerPostgresCommandRunner(
  docker: ResolvedDockerOptions,
): PostgresCommandRunner {
  return {
    writeToFile: (command, outputPath, operation) => (
      dockerToFile(docker, command, outputPath, operation)
    ),
    execute: (command, operation, inputPath) => (
      dockerCommand(docker, command, operation, inputPath)
    ),
  };
}

export function postgresEnvironmentFromUrl(connectionString: string): Record<string, string> {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !url.username || !database || database.includes('/')) {
    throw new Error('DATABASE_URL is missing PostgreSQL connection fields');
  }
  const environment: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGDATABASE: database,
  };
  if (url.password) environment.PGPASSWORD = decodeURIComponent(url.password);
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) environment.PGSSLMODE = sslMode;
  return environment;
}

const inheritedProcessEnvironmentKeys = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL',
] as const;

export function postgresProcessEnvironment(
  connectionString: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inheritedProcessEnvironmentKeys) {
    const value = baseEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...postgresEnvironmentFromUrl(connectionString) };
}

const directChild = (
  command: string[],
  environment: NodeJS.ProcessEnv,
) => {
  const [executable, ...args] = command;
  if (!executable) throw new Error('PostgreSQL command is empty');
  return spawn(executable, args, {
    env: environment,
    stdio: 'pipe',
  });
};

export function createDirectPostgresCommandRunner(
  connectionString: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): PostgresCommandRunner {
  const environment = postgresProcessEnvironment(connectionString, baseEnvironment);
  return {
    async writeToFile(command, outputPath, operation) {
      const child = directChild(command, environment);
      child.stdin.end();
      const stderr = collectStream(child.stderr);
      const exit = new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
      });
      await Promise.all([
        pipeline(child.stdout, createWriteStream(outputPath, { flags: 'wx' })),
        stderr,
        exit.then((code) => { if (code !== 0) throw commandFailure(operation, code); }),
      ]);
    },
    async execute(command, operation, inputPath) {
      const child = directChild(command, environment);
      const stdout = collectStream(child.stdout);
      const stderr = collectStream(child.stderr);
      const exit = new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
      });
      const input = inputPath
        ? pipeline(createReadStream(inputPath), child.stdin)
        : Promise.resolve(child.stdin.end());
      const [output, , exitCode] = await Promise.all([stdout, stderr, exit, input]);
      if (exitCode !== 0) throw commandFailure(operation, exitCode);
      return output.trim();
    },
  };
}

const commandRunner = (options: DockerOptions): PostgresCommandRunner => {
  if (options.runner) return options.runner;
  if (!options.composePath) throw new Error('Docker Compose path is required');
  return createDockerPostgresCommandRunner({
    composePath: options.composePath,
    ...(options.service ? { service: options.service } : {}),
    ...(options.user ? { user: options.user } : {}),
  });
};

export async function verifyBackup(dumpPath: string): Promise<BackupManifest> {
  const absoluteDump = resolve(dumpPath);
  const fileName = basename(absoluteDump);
  if (!dumpNamePattern.test(fileName)) throw new Error('Backup filename is invalid');
  const manifestPath = join(dirname(absoluteDump), manifestName(fileName));
  const manifest = backupManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (manifest.fileName !== fileName) throw new Error('Backup manifest filename does not match');
  const details = await stat(absoluteDump);
  if (details.size !== manifest.bytes) throw new Error('Backup size does not match manifest');
  if (await sha256File(absoluteDump) !== manifest.sha256) {
    throw new Error('Backup checksum does not match manifest');
  }
  return manifest;
}

const monthCutoff = (now: Date, months: number): Date => {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
};

const weekBucket = (date: Date): string => String(Math.floor(date.getTime() / (7 * dayMs)));
const monthBucket = (date: Date): string => `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;

export function selectBackupsToDelete(
  manifests: readonly BackupManifest[],
  now: Date,
  policy = backupRetentionPolicy,
): string[] {
  const weeklyCutoff = now.getTime() - policy.weeklyWeeks * 7 * dayMs;
  const monthlyCutoff = monthCutoff(now, policy.monthlyMonths).getTime();
  const dailyCutoff = now.getTime() - policy.dailyDays * dayMs;
  const weekly = new Set<string>();
  const monthly = new Set<string>();
  const sorted = [...manifests].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const keep = new Set<string>();
  for (const manifest of sorted) {
    const createdAt = new Date(manifest.createdAt);
    const timestamp = createdAt.getTime();
    if (!Number.isFinite(timestamp) || timestamp > now.getTime()) {
      keep.add(manifest.fileName);
    } else if (timestamp >= dailyCutoff) {
      keep.add(manifest.fileName);
    } else if (timestamp >= weeklyCutoff) {
      const bucket = weekBucket(createdAt);
      if (!weekly.has(bucket)) {
        weekly.add(bucket);
        keep.add(manifest.fileName);
      }
    } else if (timestamp >= monthlyCutoff) {
      const bucket = monthBucket(createdAt);
      if (!monthly.has(bucket)) {
        monthly.add(bucket);
        keep.add(manifest.fileName);
      }
    }
  }
  return sorted.filter(({ fileName }) => !keep.has(fileName)).map(({ fileName }) => fileName);
}

async function loadBackupRecords(backupDirectory: string): Promise<BackupRecord[]> {
  const directory = resolve(backupDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const records: BackupRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.manifest.json')) continue;
    const manifestPath = safeChildPath(directory, entry.name);
    try {
      const manifest = backupManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
      const dumpPath = safeChildPath(directory, manifest.fileName);
      const details = await stat(dumpPath);
      if (details.isFile() && details.size === manifest.bytes) {
        records.push({ manifest, manifestPath, dumpPath });
      }
    } catch {
      // Invalid or incomplete backups are never deleted automatically.
    }
  }
  return records;
}

export async function pruneBackups(backupDirectory: string, now = new Date()): Promise<string[]> {
  const records = await loadBackupRecords(backupDirectory);
  const deletions = new Set(selectBackupsToDelete(records.map(({ manifest }) => manifest), now));
  const removed: string[] = [];
  for (const record of records) {
    if (!deletions.has(record.manifest.fileName)) continue;
    await rm(record.dumpPath);
    await rm(record.manifestPath);
    removed.push(record.manifest.fileName);
  }
  return removed;
}

export async function createPostgresBackup(options: CreateBackupOptions): Promise<BackupRecord> {
  const now = options.now ?? new Date();
  const database = backupDatabaseNameSchema.parse(options.database ?? 'lettermate');
  const directory = resolve(options.backupDirectory);
  await mkdir(directory, { recursive: true });
  const fileName = createBackupFileName(now);
  const dumpPath = safeChildPath(directory, fileName);
  const manifestPath = safeChildPath(directory, manifestName(fileName));
  const partialDump = `${dumpPath}.partial`;
  const partialManifest = `${manifestPath}.partial`;
  await rm(partialDump, { force: true });
  await rm(partialManifest, { force: true });
  try {
    await commandRunner(options).writeToFile([
      'pg_dump', '-U', options.user ?? 'lettermate', '-d', database,
      '--format=custom', '--no-owner', '--no-privileges',
    ], partialDump, 'PostgreSQL backup');
    const details = await stat(partialDump);
    if (details.size <= 0) throw new Error('PostgreSQL backup was empty');
    const manifest = backupManifestSchema.parse({
      schemaVersion: 1,
      createdAt: now.toISOString(),
      database,
      format: 'postgres-custom',
      fileName,
      bytes: details.size,
      sha256: await sha256File(partialDump),
    });
    await writeFile(partialManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(partialDump, dumpPath);
    await rename(partialManifest, manifestPath);
    await verifyBackup(dumpPath);
    if (options.prune !== false) await pruneBackups(directory, now);
    return { manifest, manifestPath, dumpPath };
  } catch (error) {
    await rm(partialDump, { force: true });
    await rm(partialManifest, { force: true });
    throw error;
  }
}

export function validateRestoreDatabaseName(value: string): string {
  if (!databaseNamePattern.test(value)) throw new Error('Restore database name is invalid');
  if (['lettermate', 'postgres', 'template0', 'template1'].includes(value)) {
    throw new Error('Restore drills cannot target the primary or system databases');
  }
  return value;
}

const parseCount = (value: string, label: string): number => {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} verification failed`);
  return parsed;
};

export async function restorePostgresBackupForVerification(
  options: RestoreDrillOptions,
): Promise<RestoreDrillResult> {
  await verifyBackup(options.dumpPath);
  const targetDatabase = validateRestoreDatabaseName(options.targetDatabase);
  const user = options.user ?? 'lettermate';
  let created = false;
  let succeeded = false;
  const runner = commandRunner(options);
  try {
    await runner.execute(['createdb', '-U', user, targetDatabase], 'Create restore database');
    created = true;
    await runner.execute([
      'pg_restore', '-U', user, '-d', targetDatabase,
      '--no-owner', '--no-privileges', '--exit-on-error',
    ], 'Restore PostgreSQL backup', resolve(options.dumpPath));
    const tableCount = parseCount(await runner.execute([
      'psql', '-U', user, '-d', targetDatabase, '-At', '-c',
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';",
    ], 'Count restored tables'), 'Table count');
    const migrationCount = parseCount(await runner.execute([
      'psql', '-U', user, '-d', targetDatabase, '-At', '-c',
      'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;',
    ], 'Count restored migrations'), 'Migration count');
    if (tableCount === 0 || migrationCount === 0) {
      throw new Error('Restored database did not contain expected schema records');
    }
    succeeded = true;
    return { targetDatabase, tableCount, migrationCount, kept: options.keepDatabase === true };
  } finally {
    if (created && (!succeeded || options.keepDatabase !== true)) {
      await runner.execute(['dropdb', '-U', user, targetDatabase], 'Remove restore database')
        .catch(() => undefined);
    }
  }
}
