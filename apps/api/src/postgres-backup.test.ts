import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBackupFileName,
  selectBackupsToDelete,
  validateRestoreDatabaseName,
  verifyBackup,
  type BackupManifest,
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
});
