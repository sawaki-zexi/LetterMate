import { Prisma } from '@prisma/client';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const model = (modelName: string) => Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName);

const fieldNames = (modelName: string) => (
  model(modelName)?.fields.map((field) => field.name) ?? []
);

const relation = (modelName: string, fieldName: string) => (
  model(modelName)?.fields.find((field) => field.name === fieldName)
);

const uniqueConstraints = (modelName: string) => {
  const candidate = model(modelName);
  if (!candidate) return [];

  return [
    ...candidate.uniqueIndexes.map((index) => index.fields),
    ...candidate.fields.filter((field) => field.isUnique).map((field) => [field.name]),
  ];
};

const prohibitedFieldFragments = ['rank', 'score', 'payload', 'trust', 'evidence'];

describe('multi-source Prisma schema', () => {
  it('stores topic scheduling state and source-aware discovery items', () => {
    expect(fieldNames('Topic')).toEqual(expect.arrayContaining([
      'nextRunAt', 'scheduleIntervalHours', 'productiveRunStreak', 'emptyRunStreak', 'runs',
    ]));
    expect(fieldNames('DiscoveryItem')).toEqual(expect.arrayContaining([
      'sourceType', 'platform', 'authorName', 'authorHandle', 'externalId', 'provenanceKind',
    ]));
  });

  it('defines durable discovery run lifecycle fields', () => {
    expect(Prisma.dmmf.datamodel.models.map((model) => model.name)).toContain('DiscoveryRun');
    expect(fieldNames('DiscoveryRun')).toEqual(expect.arrayContaining([
      'topicId', 'trigger', 'status', 'startedAt', 'finishedAt', 'connectorSummary',
      'candidateCount', 'acceptedCount', 'newItemCount', 'error',
    ]));
  });

  it('defines one user-owned trend monitor with recoverable scheduling state', () => {
    expect(Prisma.dmmf.datamodel.models.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(['TrendMonitor', 'TrendRun', 'TrendSeed', 'RadarItem']),
    );
    expect(fieldNames('TrendMonitor')).toEqual(expect.arrayContaining([
      'userId', 'runStatus', 'nextRunAt', 'intervalHours', 'activeRunId',
      'runLeaseUntil', 'manualRefreshPending',
    ]));
    expect(relation('TrendMonitor', 'user')).toMatchObject({
      relationFromFields: ['userId'],
      relationOnDelete: 'Cascade',
    });
    expect(fieldNames('User')).toEqual(expect.arrayContaining(['trendMonitor', 'trendRuns', 'trendSeeds', 'radarItems']));
    expect(uniqueConstraints('TrendMonitor')).toContainEqual(['userId']);
  });

  it('persists trend runs and seeds without rankings, scores, payloads, or trust metadata', () => {
    expect(fieldNames('TrendRun')).toEqual(expect.arrayContaining([
      'userId', 'monitorId', 'trigger', 'status', 'startedAt', 'finishedAt',
      'candidateCount', 'acceptedCount', 'newItemCount', 'error',
    ]));
    expect(fieldNames('TrendSeed')).toEqual(expect.arrayContaining([
      'userId', 'runId', 'sourceId', 'platform', 'externalId', 'title', 'sourceUrl',
      'fingerprint', 'publishedAt', 'discoveredAt', 'normalizedQuery',
    ]));
    for (const modelName of ['TrendMonitor', 'TrendRun', 'TrendSeed', 'RadarItem']) {
      expect(relation(modelName, 'user')).toMatchObject({
        relationFromFields: ['userId'],
        relationOnDelete: 'Cascade',
      });
      for (const prohibitedFieldFragment of prohibitedFieldFragments) {
        expect(fieldNames(modelName).some((fieldName) => (
          fieldName.toLowerCase().includes(prohibitedFieldFragment)
        ))).toBe(false);
      }
    }
    expect(relation('TrendRun', 'monitor')).toMatchObject({ relationOnDelete: 'Cascade' });
    expect(relation('TrendSeed', 'run')).toMatchObject({ relationOnDelete: 'Cascade' });
  });

  it('stores user-visible radar discovery fields with per-user URL deduplication', () => {
    expect(fieldNames('RadarItem')).toEqual(expect.arrayContaining([
      'userId', 'runId', 'kind', 'title', 'summary', 'reason', 'sourceUrls',
      'canonicalPrimaryUrl', 'publishedAt', 'discoveredAt', 'sourceType', 'platform',
      'authorName', 'authorHandle', 'externalId', 'provenanceKind',
    ]));
    expect(uniqueConstraints('RadarItem')).toContainEqual(['userId', 'canonicalPrimaryUrl']);
    expect(relation('RadarItem', 'run')).toMatchObject({ relationOnDelete: 'Cascade' });
  });

  it('migrates monitors, trend records, and operational indexes for existing users', () => {
    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260728_trend_monitoring', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    const normalizedMigration = migration.replace(/\s+/g, ' ').trim();

    for (const tableName of ['TrendMonitor', 'TrendRun', 'TrendSeed', 'RadarItem']) {
      expect(normalizedMigration).toContain(`CREATE TABLE "${tableName}"`);
    }
    for (const indexName of [
      'TrendMonitor_userId_key',
      'TrendMonitor_nextRunAt_runStatus_idx',
      'TrendMonitor_runStatus_runLeaseUntil_idx',
      'TrendRun_userId_status_startedAt_idx',
      'TrendRun_monitorId_startedAt_idx',
      'TrendSeed_userId_fingerprint_discoveredAt_idx',
      'TrendSeed_runId_discoveredAt_idx',
      'RadarItem_userId_canonicalPrimaryUrl_key',
      'RadarItem_userId_publishedAt_discoveredAt_idx',
      'RadarItem_runId_discoveredAt_idx',
    ]) {
      expect(normalizedMigration).toMatch(new RegExp(`CREATE(?: UNIQUE)? INDEX "${indexName}" ON`));
    }
    for (const [tableName, constraintName] of [
      ['TrendMonitor', 'TrendMonitor_userId_fkey'],
      ['TrendRun', 'TrendRun_userId_fkey'],
      ['TrendRun', 'TrendRun_monitorId_fkey'],
      ['TrendSeed', 'TrendSeed_userId_fkey'],
      ['TrendSeed', 'TrendSeed_runId_fkey'],
      ['RadarItem', 'RadarItem_userId_fkey'],
      ['RadarItem', 'RadarItem_runId_fkey'],
    ]) {
      expect(normalizedMigration).toMatch(new RegExp(
        `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY \\([^;]+ ON DELETE CASCADE ON UPDATE CASCADE;`,
      ));
    }
    expect(normalizedMigration).toMatch(
      /INSERT INTO "TrendMonitor" \("id", "userId", "runStatus", "nextRunAt", "intervalHours", "manualRefreshPending"\) SELECT .+ "id", 'queued', NOW\(\), 4, false FROM "User";/,
    );
  });
});
