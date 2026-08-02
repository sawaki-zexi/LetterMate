import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

const modelSource = (modelName: string) => (
  schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
);

const fieldLine = (modelName: string, fieldName: string) => (
  modelSource(modelName).match(new RegExp(`^  ${fieldName}\\s+([^\\n]+)$`, 'm'))?.[1] ?? ''
);

const fieldNames = (modelName: string) => (
  [...modelSource(modelName).matchAll(/^  (\w+)\s+/gm)].map((match) => match[1])
);

const modelNames = () => [...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]);

const relation = (modelName: string, fieldName: string) => {
  const line = fieldLine(modelName, fieldName);
  const relationFields = line.match(/fields: \[([^\]]*)\]/)?.[1];
  const relationReferences = line.match(/references: \[([^\]]*)\]/)?.[1];

  return {
    isRequired: !line.split(/\s+/)[0]?.endsWith('?'),
    ...(relationFields ? { relationFromFields: relationFields.split(', ').map((field) => field.trim()) } : {}),
    ...(relationReferences ? { relationToFields: relationReferences.split(', ').map((field) => field.trim()) } : {}),
    ...(line.includes('onDelete: Cascade') ? { relationOnDelete: 'Cascade' } : {}),
  };
};

const uniqueConstraints = (modelName: string) => {
  return [
    ...[...modelSource(modelName).matchAll(/@@unique\(\[([^\]]+)\]\)/g)]
      .map((match) => match[1].split(', ').map((field) => field.trim())),
    ...fieldNames(modelName).filter((fieldName) => fieldLine(modelName, fieldName).includes('@unique'))
      .map((fieldName) => [fieldName]),
  ];
};

const prohibitedFieldFragments = ['rank', 'score', 'payload', 'trust', 'evidence'];

describe('multi-source Prisma schema', () => {
  it('stores topic scheduling state and source-aware discovery items', () => {
    expect(fieldNames('Topic')).toEqual(expect.arrayContaining([
      'nextRunAt', 'scheduleIntervalHours', 'productiveRunStreak', 'emptyRunStreak', 'runs',
      'deletedAt', 'variantsInitialized',
    ]));
    expect(fieldNames('DiscoveryItem')).toEqual(expect.arrayContaining([
      'sourceType', 'platform', 'authorName', 'authorHandle', 'externalId', 'provenanceKind',
      'topicKeyword',
    ]));
  });

  it('defines durable discovery run lifecycle fields', () => {
    expect(modelNames()).toContain('DiscoveryRun');
    expect(fieldNames('DiscoveryRun')).toEqual(expect.arrayContaining([
      'topicId', 'trigger', 'status', 'startedAt', 'finishedAt', 'connectorSummary',
      'candidateCount', 'acceptedCount', 'newItemCount', 'error', 'keywordSnapshot',
      'expandedTermsSnapshot',
    ]));
  });

  it('defines one user-owned trend monitor with recoverable scheduling state', () => {
    expect(modelNames()).toEqual(
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
    expect(uniqueConstraints('TrendMonitor')).toContainEqual(['id', 'userId']);
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
    expect(relation('TrendRun', 'monitor')).toMatchObject({
      relationFromFields: ['monitorId', 'userId'],
      relationToFields: ['id', 'userId'],
      relationOnDelete: 'Cascade',
    });
    expect(uniqueConstraints('TrendRun')).toContainEqual(['id', 'userId']);
    expect(relation('TrendSeed', 'run')).toMatchObject({
      relationFromFields: ['runId', 'userId'],
      relationToFields: ['id', 'userId'],
      relationOnDelete: 'Cascade',
    });
    expect(relation('TrendSeed', 'normalizedQuery')).toMatchObject({ isRequired: false });
    expect(uniqueConstraints('TrendSeed')).toContainEqual(['runId', 'fingerprint']);
  });

  it('stores user-visible radar discovery fields with per-user URL deduplication', () => {
    expect(fieldNames('RadarItem')).toEqual(expect.arrayContaining([
      'userId', 'runId', 'kind', 'title', 'summary', 'reason', 'sourceUrls',
      'canonicalPrimaryUrl', 'publishedAt', 'discoveredAt', 'sourceType', 'platform',
      'authorName', 'authorHandle', 'externalId', 'provenanceKind',
    ]));
    expect(uniqueConstraints('RadarItem')).toContainEqual(['userId', 'canonicalPrimaryUrl']);
    expect(relation('RadarItem', 'run')).toMatchObject({
      relationFromFields: ['runId', 'userId'],
      relationToFields: ['id', 'userId'],
      relationOnDelete: 'Cascade',
    });
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
    const expectedUniqueIndexes: Array<[string, string, string[]]> = [
      ['TrendMonitor_userId_key', 'TrendMonitor', ['userId']],
      ['TrendMonitor_id_userId_key', 'TrendMonitor', ['id', 'userId']],
      ['TrendRun_id_userId_key', 'TrendRun', ['id', 'userId']],
      ['RadarItem_userId_canonicalPrimaryUrl_key', 'RadarItem', ['userId', 'canonicalPrimaryUrl']],
    ];
    for (const [indexName, tableName, columns] of expectedUniqueIndexes) {
      expect(normalizedMigration).toMatch(new RegExp(
        `CREATE UNIQUE INDEX "${indexName}" ON "${tableName}"\\("${columns.join('", "')}"\\);`,
      ));
    }
    expect(normalizedMigration).not.toContain(
      'CREATE UNIQUE INDEX "TrendSeed_runId_fingerprint_key"',
    );
    const expectedIndexes: Array<[string, string, string[]]> = [
      ['TrendMonitor_nextRunAt_runStatus_idx', 'TrendMonitor', ['nextRunAt', 'runStatus']],
      ['TrendMonitor_runStatus_runLeaseUntil_idx', 'TrendMonitor', ['runStatus', 'runLeaseUntil']],
      ['TrendRun_userId_status_startedAt_idx', 'TrendRun', ['userId', 'status', 'startedAt']],
      ['TrendRun_monitorId_startedAt_idx', 'TrendRun', ['monitorId', 'startedAt']],
      ['TrendSeed_userId_fingerprint_discoveredAt_idx', 'TrendSeed', ['userId', 'fingerprint', 'discoveredAt']],
      ['TrendSeed_runId_discoveredAt_idx', 'TrendSeed', ['runId', 'discoveredAt']],
      ['RadarItem_userId_publishedAt_discoveredAt_idx', 'RadarItem', ['userId', 'publishedAt', 'discoveredAt']],
      ['RadarItem_runId_discoveredAt_idx', 'RadarItem', ['runId', 'discoveredAt']],
    ];
    for (const [indexName, tableName, columns] of expectedIndexes) {
      expect(normalizedMigration).toMatch(new RegExp(
        `CREATE INDEX "${indexName}" ON "${tableName}"\\("${columns.join('", "')}"\\);`,
      ));
    }
    for (const [tableName, constraintName] of [
      ['TrendMonitor', 'TrendMonitor_userId_fkey'],
      ['TrendRun', 'TrendRun_userId_fkey'],
      ['TrendSeed', 'TrendSeed_userId_fkey'],
      ['RadarItem', 'RadarItem_userId_fkey'],
    ]) {
      expect(normalizedMigration).toContain(
        `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      );
    }
    const expectedCompositeRelations: Array<[string, string, string[], string]> = [
      ['TrendRun', 'TrendRun_monitorId_userId_fkey', ['monitorId', 'userId'], 'TrendMonitor'],
      ['TrendSeed', 'TrendSeed_runId_userId_fkey', ['runId', 'userId'], 'TrendRun'],
      ['RadarItem', 'RadarItem_runId_userId_fkey', ['runId', 'userId'], 'TrendRun'],
    ];
    for (const [
      tableName,
      constraintName,
      childColumns,
      parentTable,
    ] of expectedCompositeRelations) {
      expect(normalizedMigration).toContain(
        `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${childColumns.join('", "')}") REFERENCES "${parentTable}"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;`,
      );
    }
    expect(normalizedMigration).toMatch(
      /CREATE TABLE "TrendMonitor" \([^;]*"runStatus" "RunStatus" NOT NULL DEFAULT 'queued',[^;]*"nextRunAt" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP,[^;]*"intervalHours" INTEGER NOT NULL DEFAULT 4,[^;]*"manualRefreshPending" BOOLEAN NOT NULL DEFAULT false,/,
    );
    expect(normalizedMigration).toMatch(
      /CREATE TABLE "TrendRun" \([^;]*"trigger" "DiscoveryTrigger" NOT NULL,[^;]*"status" "RunStatus" NOT NULL DEFAULT 'queued',[^;]*"candidateCount" INTEGER NOT NULL DEFAULT 0,[^;]*"acceptedCount" INTEGER NOT NULL DEFAULT 0,[^;]*"newItemCount" INTEGER NOT NULL DEFAULT 0,/,
    );
    expect(normalizedMigration).toMatch(
      /CREATE TABLE "TrendSeed" \([^;]*"normalizedQuery" TEXT,[^;]*CONSTRAINT "TrendSeed_pkey"/,
    );
    expect(normalizedMigration).toMatch(
      /CREATE TABLE "RadarItem" \([^;]*"sourceUrls" TEXT\[\] NOT NULL,[^;]*"provenanceKind" "ProvenanceKind" NOT NULL DEFAULT 'ai_citation',/,
    );
    expect(normalizedMigration).toMatch(
      /INSERT INTO "TrendMonitor" \("id", "userId", "runStatus", "nextRunAt", "intervalHours", "manualRefreshPending"\) SELECT .+ "id", 'queued', NOW\(\), 4, false FROM "User";/,
    );
  });

  it('deduplicates trend seeds before adding the run fingerprint unique index', () => {
    const migrationPath = join(
      process.cwd(),
      'prisma',
      'migrations',
      '20260728_trend_seed_run_fingerprint_unique',
      'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    const normalizedMigration = migration.replace(/\s+/g, ' ').trim();

    expect(normalizedMigration).toContain(
      'LOCK TABLE "TrendSeed" IN SHARE ROW EXCLUSIVE MODE;',
    );
    expect(normalizedMigration).toMatch(
      /DELETE FROM "TrendSeed" AS "duplicate" USING "TrendSeed" AS "retained" WHERE "duplicate"\."runId" = "retained"\."runId" AND "duplicate"\."fingerprint" = "retained"\."fingerprint" AND \( "duplicate"\."discoveredAt" > "retained"\."discoveredAt" OR \( "duplicate"\."discoveredAt" = "retained"\."discoveredAt" AND "duplicate"\."id" > "retained"\."id" \) \);/,
    );
    expect(normalizedMigration).toContain(
      'CREATE UNIQUE INDEX "TrendSeed_runId_fingerprint_key" ON "TrendSeed"("runId", "fingerprint");',
    );
  });

  it('preserves topic keyword history and permits re-creating deleted keywords', () => {
    expect(fieldLine('Topic', 'deletedAt')).toMatch(/^DateTime\?/);
    expect(fieldLine('Topic', 'variantsInitialized')).toContain('Boolean');
    expect(fieldLine('Topic', 'variantsInitialized')).toContain('@default(false)');
    expect(fieldLine('DiscoveryRun', 'keywordSnapshot')).toMatch(/^String/);
    expect(fieldLine('DiscoveryRun', 'expandedTermsSnapshot')).toContain('String[]');
    expect(fieldLine('DiscoveryRun', 'expandedTermsSnapshot')).toContain('@default([])');
    expect(fieldLine('DiscoveryItem', 'topicKeyword')).toMatch(/^String/);
    expect(uniqueConstraints('Topic')).not.toContainEqual(['userId', 'normalizedKeyword']);
    expect(modelSource('Topic')).toContain('@@index([userId, deletedAt, createdAt])');

    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260802_topic_keyword_management', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    const normalizedMigration = migration.replace(/\s+/g, ' ').trim();

    expect(normalizedMigration).toContain('ALTER TABLE "Topic" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "variantsInitialized" BOOLEAN NOT NULL DEFAULT false;');
    expect(normalizedMigration).toContain('ALTER TABLE "DiscoveryRun" ADD COLUMN "keywordSnapshot" TEXT, ADD COLUMN "expandedTermsSnapshot" TEXT[];');
    expect(normalizedMigration).toContain('ALTER TABLE "DiscoveryItem" ADD COLUMN "topicKeyword" TEXT;');
    expect(normalizedMigration).toContain('UPDATE "DiscoveryRun" AS "run" SET "keywordSnapshot" = "topic"."keyword", "expandedTermsSnapshot" = "topic"."expandedTerms" FROM "Topic" AS "topic" WHERE "run"."topicId" = "topic"."id";');
    expect(normalizedMigration).toContain('UPDATE "DiscoveryItem" AS "item" SET "topicKeyword" = "topic"."keyword" FROM "Topic" AS "topic" WHERE "item"."topicId" = "topic"."id";');
    expect(normalizedMigration).toContain('ALTER TABLE "DiscoveryRun" ALTER COLUMN "keywordSnapshot" SET NOT NULL;');
    expect(normalizedMigration).toContain('ALTER TABLE "DiscoveryRun" ALTER COLUMN "expandedTermsSnapshot" SET DEFAULT ARRAY[]::TEXT[];');
    expect(normalizedMigration).toContain('ALTER TABLE "DiscoveryRun" ALTER COLUMN "expandedTermsSnapshot" SET NOT NULL;');
    expect(normalizedMigration).toContain('ALTER TABLE "DiscoveryItem" ALTER COLUMN "topicKeyword" SET NOT NULL;');
    expect(normalizedMigration).toContain('DROP INDEX "Topic_userId_normalizedKeyword_key";');
    expect(normalizedMigration).toContain('CREATE UNIQUE INDEX "Topic_userId_normalizedKeyword_active_key" ON "Topic"("userId", "normalizedKeyword") WHERE "deletedAt" IS NULL;');
    expect(normalizedMigration).toContain('CREATE INDEX "Topic_userId_deletedAt_createdAt_idx" ON "Topic"("userId", "deletedAt", "createdAt");');
  });
});
