import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostgresBackup,
  createBackupFileName,
  postgresEnvironmentFromUrl,
  postgresProcessEnvironment,
  restorePostgresBackupForVerification,
  selectBackupsToDelete,
  validateRestoreDatabaseName,
  verifyBackup,
  type BackupManifest,
  type PostgresCommandRunner,
} from './postgres-backup.js';

const temporaryDirectories: string[] = [];

const manifest = (createdAt: string): BackupManifest => ({
  schemaVersion: 1,
  createdAt,
  database: 'lettermate',
  format: 'postgres-custom',
  fileName: createBackupFileName(new Date(createdAt)),
  bytes: 1,
  sha256: 'a'.repeat(64),
});

describe('PostgreSQL backup operations', () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
      recursive: true, force: true,
    })));
  });

  it('applies daily, weekly, and monthly retention without deleting invalid future records', () => {
    const backups = [
      manifest('2026-08-30T00:00:00.000Z'),
      manifest('2026-08-11T00:00:00.000Z'),
      manifest('2026-08-10T00:00:00.000Z'),
      manifest('2026-06-20T00:00:00.000Z'),
      manifest('2026-06-10T00:00:00.000Z'),
      manifest('2025-01-01T00:00:00.000Z'),
      manifest('2026-09-01T00:00:00.000Z'),
    ];

    expect(selectBackupsToDelete(backups, new Date('2026-08-31T00:00:00.000Z'))).toEqual([
      createBackupFileName(new Date('2026-08-10T00:00:00.000Z')),
      createBackupFileName(new Date('2026-06-10T00:00:00.000Z')),
      createBackupFileName(new Date('2025-01-01T00:00:00.000Z')),
    ]);
  });

  it('verifies manifest size and checksum before restore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lettermate-backup-'));
    temporaryDirectories.push(directory);
    const createdAt = '2026-08-08T08:00:00.000Z';
    const fileName = createBackupFileName(new Date(createdAt));
    const dumpPath = join(directory, fileName);
    const content = Buffer.from('postgres custom backup fixture');
    await writeFile(dumpPath, content);
    await writeFile(join(directory, fileName.replace('.dump', '.manifest.json')), JSON.stringify({
      schemaVersion: 1,
      createdAt,
      database: 'lettermate',
      format: 'postgres-custom',
      fileName,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    }));

    await expect(verifyBackup(dumpPath)).resolves.toMatchObject({ fileName, bytes: content.length });
    await writeFile(dumpPath, 'tampered');
    await expect(verifyBackup(dumpPath)).rejects.toThrow(/size|checksum/);
  });

  it('allows only isolated restore databases', () => {
    expect(validateRestoreDatabaseName('lettermate_restore_20260808')).toBe('lettermate_restore_20260808');
    expect(() => validateRestoreDatabaseName('lettermate')).toThrow(/cannot target/);
    expect(() => validateRestoreDatabaseName('postgres')).toThrow(/cannot target/);
    expect(() => validateRestoreDatabaseName('unsafe-name')).toThrow(/invalid/);
  });

  it('maps a PostgreSQL URL to libpq environment variables without changing credentials', () => {
    expect(postgresEnvironmentFromUrl(
      'postgresql://backup%20user:p%40ss@database.internal:5433/lettermate?sslmode=require',
    )).toEqual({
      PGHOST: 'database.internal',
      PGPORT: '5433',
      PGUSER: 'backup user',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'lettermate',
      PGSSLMODE: 'require',
    });
    expect(() => postgresEnvironmentFromUrl('https://database.internal/lettermate'))
      .toThrow(/postgres/);
    expect(() => postgresEnvironmentFromUrl('postgresql://database.internal/'))
      .toThrow(/missing/);

    const childEnvironment = postgresProcessEnvironment(
      'postgresql://user:password@database.internal/lettermate',
      { PATH: '/bin', AI_API_KEY: 'must-not-be-inherited', DATABASE_URL: 'must-not-be-inherited' },
    );
    expect(childEnvironment).toMatchObject({ PATH: '/bin', PGPASSWORD: 'password' });
    expect(childEnvironment).not.toHaveProperty('AI_API_KEY');
    expect(childEnvironment).not.toHaveProperty('DATABASE_URL');
  });

  it('creates and verifies a backup through an injected runner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lettermate-backup-runner-'));
    temporaryDirectories.push(directory);
    const runner: PostgresCommandRunner = {
      writeToFile: async (_command, outputPath) => {
        await writeFile(outputPath, 'custom-format-dump');
      },
      execute: async () => '',
    };

    const result = await createPostgresBackup({
      backupDirectory: directory,
      runner,
      prune: false,
      now: new Date('2026-08-09T02:00:00.000Z'),
    });

    await expect(verifyBackup(result.dumpPath)).resolves.toEqual(result.manifest);
    expect(result.manifest.bytes).toBeGreaterThan(0);
  });

  it('backs up and records the database selected by DATABASE_URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lettermate-backup-database-'));
    temporaryDirectories.push(directory);
    const commands: string[][] = [];
    const runner: PostgresCommandRunner = {
      writeToFile: async (command, outputPath) => {
        commands.push(command);
        await writeFile(outputPath, 'custom-format-dump');
      },
      execute: async () => '',
    };

    const result = await createPostgresBackup({
      backupDirectory: directory,
      database: 'custom_production_db',
      runner,
      prune: false,
      now: new Date('2026-08-09T02:30:00.000Z'),
    } as Parameters<typeof createPostgresBackup>[0] & { database: string });

    expect(commands[0]).toContain('custom_production_db');
    expect(result.manifest.database).toBe('custom_production_db');
  });

  it('runs an isolated restore drill through an injected runner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lettermate-restore-runner-'));
    temporaryDirectories.push(directory);
    const createdAt = '2026-08-09T03:00:00.000Z';
    const fileName = createBackupFileName(new Date(createdAt));
    const dumpPath = join(directory, fileName);
    const content = Buffer.from('restore fixture');
    await writeFile(dumpPath, content);
    await writeFile(join(directory, fileName.replace('.dump', '.manifest.json')), JSON.stringify({
      schemaVersion: 1,
      createdAt,
      database: 'lettermate',
      format: 'postgres-custom',
      fileName,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    }));
    const commands: string[][] = [];
    const runner: PostgresCommandRunner = {
      writeToFile: async () => {},
      execute: async (command) => {
        commands.push(command);
        if (command.some((value) => value.includes('information_schema.tables'))) return '27';
        if (command.some((value) => value.includes('finished_at IS NOT NULL;'))) return '20';
        return '';
      },
    };

    await expect(restorePostgresBackupForVerification({
      dumpPath,
      targetDatabase: 'lettermate_restore_test',
      runner,
    })).resolves.toEqual({
      targetDatabase: 'lettermate_restore_test',
      tableCount: 27,
      migrationCount: 20,
      kept: false,
    });
    expect(commands.map(([command]) => command)).toEqual([
      'createdb', 'pg_restore', 'psql', 'psql', 'dropdb',
    ]);
  });
});
