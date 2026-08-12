import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

const modelSource = (modelName: string) => (
  schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
);

const fieldLine = (modelName: string, fieldName: string) => (
  modelSource(modelName).match(new RegExp(`^ {2}${fieldName}\\s+([^\\n]+)$`, 'm'))?.[1] ?? ''
);

const fieldNames = (modelName: string) => (
  [...modelSource(modelName).matchAll(/^ {2}(\w+)\s+/gm)].map((match) => match[1]!)
);

const modelNames = () => [...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]!);

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
      .map((match) => match[1]!.split(', ').map((field) => field.trim())),
    ...fieldNames(modelName).filter((fieldName) => fieldLine(modelName, fieldName).includes('@unique'))
      .map((fieldName) => [fieldName]),
  ];
};

const prohibitedFieldFragments = ['rank', 'score', 'payload', 'trust', 'evidence'];

describe('multi-source Prisma schema', () => {
  it('stores versioned run stages and private replayable artifacts', () => {
    expect(modelNames()).toEqual(expect.arrayContaining(['RunStage', 'RunArtifact']));
    expect(fieldNames('RunStage')).toEqual(expect.arrayContaining([
      'runKind', 'runId', 'userId', 'stage', 'status', 'attempt', 'inputDigest',
      'policyVersion', 'routeVersion', 'startedAt', 'finishedAt', 'errorCode',
    ]));
    expect(fieldNames('RunArtifact')).toEqual(expect.arrayContaining([
      'stageId', 'data', 'byteLength', 'createdAt', 'stage',
    ]));
    expect(relation('RunStage', 'user')).toMatchObject({
      relationFromFields: ['userId'], relationOnDelete: 'Cascade',
    });
    expect(relation('RunArtifact', 'stage')).toMatchObject({
      relationFromFields: ['stageId'], relationOnDelete: 'Cascade',
    });
    expect(uniqueConstraints('RunStage')).toContainEqual([
      'userId', 'runKind', 'runId', 'stage', 'inputDigest', 'policyVersion', 'routeVersion',
    ]);
    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260809_run_stage_checkpoints', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    expect(migration).toContain('CREATE TABLE "RunStage"');
    expect(migration).toContain('CREATE TABLE "RunArtifact"');
    expect(migration).toContain('CREATE TYPE "RunStageName" AS ENUM');
  });

  it('stores user-owned AI run budgets and per-call usage without provider payloads', () => {
    expect(modelNames()).toEqual(expect.arrayContaining(['AiRunBudget', 'AiUsage']));
    expect(fieldNames('AiRunBudget')).toEqual(expect.arrayContaining([
      'runKind', 'runId', 'userId', 'policyVersion', 'budgetVersion',
      'maxCalls', 'maxInputTokens', 'maxOutputTokens', 'maxCostMicros',
      'reservedCalls', 'reservedInputTokens', 'reservedOutputTokens',
      'reservedCostMicros',
    ]));
    expect(fieldNames('AiUsage')).toEqual(expect.arrayContaining([
      'runKind', 'runId', 'userId', 'task', 'status', 'routeVersion',
      'requestedModel', 'actualModel', 'provider', 'estimatedInputTokens',
      'reservedOutputTokens', 'reservedCostMicros', 'inputTokens', 'outputTokens',
      'reasoningTokens', 'cachedTokens', 'costMicros', 'errorCode',
    ]));
    expect(fieldNames('AiUsage')).not.toEqual(expect.arrayContaining(['request', 'response', 'payload']));
    expect(relation('AiRunBudget', 'user')).toMatchObject({
      relationFromFields: ['userId'], relationOnDelete: 'Cascade',
    });
    expect(relation('AiUsage', 'budget')).toMatchObject({
      relationFromFields: ['runKind', 'runId'],
      relationToFields: ['runKind', 'runId'],
      relationOnDelete: 'Cascade',
    });

    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260808_ai_runtime_budget', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    expect(migration).toContain('CREATE TABLE "AiRunBudget"');
    expect(migration).toContain('CREATE TABLE "AiUsage"');
    expect(migration).toContain('CREATE TYPE "AiTask" AS ENUM');
    expect(schema).toMatch(/enum AiTask \{[\s\S]*evidence_gap_detection[\s\S]*\}/);
    const evidenceGapMigrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260809_evidence_gap_task', 'migration.sql',
    );
    const evidenceGapMigration = existsSync(evidenceGapMigrationPath)
      ? readFileSync(evidenceGapMigrationPath, 'utf8') : '';
    expect(evidenceGapMigration).toContain(
      'ALTER TYPE "AiTask" ADD VALUE \'evidence_gap_detection\';',
    );
  });

  it('stores topic scheduling state and source-aware discovery items', () => {
    expect(fieldNames('Topic')).toEqual(expect.arrayContaining([
      'nextRunAt', 'scheduleIntervalHours', 'productiveRunStreak', 'emptyRunStreak', 'runs',
      'deletedAt', 'pausedAt', 'variantsInitialized', 'keywordProfile',
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
      'expandedTermsSnapshot', 'keywordProfileSnapshot',
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
    expect(normalizedMigration).toContain('UPDATE "Topic" SET "variantsInitialized" = true;');
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

  it('supports stable X creator accounts and content relationships', () => {
      expect(schema).toContain('enum CreatorPlatform {\n  rss\n  x\n  bilibili\n  youtube\n  bluesky\n}');
    expect(fieldLine('CreatorSubscription', 'feedUrl')).toMatch(/^String\?/);
    expect(fieldNames('CreatorItem')).toEqual(expect.arrayContaining([
      'contentType', 'originalAuthorName', 'originalAuthorHandle', 'originalContentId',
      'originalContentUrl', 'parentContentId', 'parentContentUrl', 'parentContentText',
    ]));
    const migrationPath = join(process.cwd(), 'prisma', 'migrations', '20260807_x_creator_support', 'migration.sql');
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    expect(migration).toContain('ALTER TYPE "CreatorPlatform" ADD VALUE \'x\';');
    expect(migration).toContain('CREATE TYPE "CreatorContentType" AS ENUM');
    const bilibiliMigrationPath = join(process.cwd(), 'prisma', 'migrations', '20260807_bilibili_creator_support', 'migration.sql');
    const bilibiliMigration = existsSync(bilibiliMigrationPath) ? readFileSync(bilibiliMigrationPath, 'utf8') : '';
    expect(bilibiliMigration).toContain('ALTER TYPE "CreatorPlatform" ADD VALUE \'bilibili\';');
    const youtubeMigrationPath = join(process.cwd(), 'prisma', 'migrations', '20260810_youtube_creator', 'migration.sql');
    const youtubeMigration = existsSync(youtubeMigrationPath) ? readFileSync(youtubeMigrationPath, 'utf8') : '';
    expect(youtubeMigration).toContain('ALTER TYPE "CreatorPlatform" ADD VALUE IF NOT EXISTS \'youtube\';');
    const blueskyMigrationPath = join(process.cwd(), 'prisma', 'migrations', '20260810_bluesky_creator', 'migration.sql');
    const blueskyMigration = existsSync(blueskyMigrationPath) ? readFileSync(blueskyMigrationPath, 'utf8') : '';
    expect(blueskyMigration).toContain('ALTER TYPE "CreatorPlatform" ADD VALUE IF NOT EXISTS \'bluesky\';');
  });

  it('stores one user-owned feedback value per normalized content key', () => {
    expect(schema).toContain("enum FeedbackValue {\n  interested\n  less\n}");
    expect(fieldNames('ContentFeedback')).toEqual(expect.arrayContaining([
      'id', 'userId', 'contentKey', 'value', 'createdAt', 'updatedAt', 'user',
    ]));
    expect(uniqueConstraints('ContentFeedback')).toContainEqual(['userId', 'contentKey']);
    expect(relation('ContentFeedback', 'user')).toMatchObject({
      relationFromFields: ['userId'],
      relationOnDelete: 'Cascade',
    });
    expect(fieldNames('User')).toContain('feedback');

    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260808_content_feedback', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "ContentFeedback_userId_contentKey_key" ON "ContentFeedback"("userId", "contentKey");',
    );
    expect(migration).toContain(
      'ALTER TABLE "ContentFeedback" ADD CONSTRAINT "ContentFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
  });

  it('persists the inferred keyword profile and snapshots it for each run', () => {
    expect(fieldLine('Topic', 'keywordProfile')).toContain('KeywordProfileKind');
    expect(fieldLine('Topic', 'keywordProfile')).toContain('@default(unknown)');
    expect(fieldLine('DiscoveryRun', 'keywordProfileSnapshot')).toContain('KeywordProfileKind');
    expect(fieldLine('DiscoveryRun', 'keywordProfileSnapshot')).toContain('@default(unknown)');

    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260806_keyword_monitoring_profile', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    const normalizedMigration = migration.replace(/\s+/g, ' ').trim();

    expect(normalizedMigration).toContain(
      `CREATE TYPE "KeywordProfileKind" AS ENUM ('entity', 'domain', 'unknown');`,
    );
    expect(normalizedMigration).toContain(
      `ADD COLUMN "keywordProfile" "KeywordProfileKind" NOT NULL DEFAULT 'unknown';`,
    );
    expect(normalizedMigration).toContain(
      `ADD COLUMN "keywordProfileSnapshot" "KeywordProfileKind" NOT NULL DEFAULT 'unknown';`,
    );
  });

  it('persists Topic pause state and indexes it with the next run time', () => {
    expect(fieldLine('Topic', 'pausedAt')).toMatch(/^DateTime\?/);
    expect(modelSource('Topic')).toContain('@@index([pausedAt, nextRunAt])');

    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260806_topic_monitor_pause', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    const normalizedMigration = migration.replace(/\s+/g, ' ').trim();

    expect(normalizedMigration).toContain('ADD COLUMN "pausedAt" TIMESTAMP(3);');
    expect(normalizedMigration).toContain(
      'CREATE INDEX "Topic_pausedAt_nextRunAt_idx" ON "Topic"("pausedAt", "nextRunAt");',
    );
  });

  it('stores versioned interest tags and an auditable current-state event ledger', () => {
    expect(modelNames()).toEqual(expect.arrayContaining([
      'InterestTag', 'ContentInterestTag', 'InterestEvent',
    ]));
    expect(fieldNames('InterestTag')).toEqual(expect.arrayContaining([
      'slug', 'displayName', 'parentId', 'kind', 'status', 'taxonomyVersion',
    ]));
    expect(uniqueConstraints('InterestTag')).toContainEqual(['slug', 'taxonomyVersion']);
    expect(fieldNames('ContentInterestTag')).toEqual(expect.arrayContaining([
      'contentKey', 'tagId', 'confidence', 'extractorVersion', 'createdAt',
    ]));
    expect(fieldNames('InterestEvent')).toEqual(expect.arrayContaining([
      'userId', 'eventType', 'sourceRef', 'activeKey', 'payload',
      'occurredAt', 'recordedAt', 'supersededAt',
    ]));
    expect(uniqueConstraints('InterestEvent')).toContainEqual(['userId', 'eventType', 'activeKey']);
    expect(relation('InterestEvent', 'user')).toMatchObject({
      relationFromFields: ['userId'],
      relationOnDelete: 'Cascade',
    });

    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260808_interest_memory_a1', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    expect(migration).toContain('CREATE TABLE "InterestTag"');
    expect(migration).toContain('CREATE TABLE "ContentInterestTag"');
    expect(migration).toContain('CREATE TABLE "InterestEvent"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "InterestEvent_userId_eventType_activeKey_key" ON "InterestEvent"("userId", "eventType", "activeKey");',
    );
  });

  it('stores versioned canonical interest adjacency and backfills qualified pairs', () => {
    expect(modelNames()).toContain('InterestTagAdjacency');
    expect(fieldNames('InterestTagAdjacency')).toEqual(expect.arrayContaining([
      'leftTagId', 'rightTagId', 'relationVersion', 'createdAt',
    ]));
    expect(relation('InterestTagAdjacency', 'leftTag')).toMatchObject({
      relationFromFields: ['leftTagId'], relationOnDelete: 'Cascade',
    });
    expect(relation('InterestTagAdjacency', 'rightTag')).toMatchObject({
      relationFromFields: ['rightTagId'], relationOnDelete: 'Cascade',
    });

    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260808_interest_adjacency', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    expect(migration).toContain('CREATE TABLE "InterestTagAdjacency"');
    expect(migration).toContain("'qualified-content-cooccurrence-v1'");
    expect(migration).toContain('left_content."confidence" >= 0.75');
    expect(migration).toContain('right_tag."kind" <> \'content_type\'');
  });

  it('stores digest preferences, run boundaries, and frozen item snapshots', () => {
    expect(modelNames()).toEqual(expect.arrayContaining([
      'DigestPreference', 'DigestTestEmail', 'DigestRun', 'DigestItem',
    ]));
    expect(fieldNames('DigestPreference')).toEqual(expect.arrayContaining([
      'userId', 'enabled', 'localSendTime', 'unsubscribeTokenId',
      'recipientSuppressionReason', 'recipientSuppressedAt', 'updatedAt',
    ]));
    expect(fieldNames('DigestRun')).toEqual(expect.arrayContaining([
      'userId', 'recipientEmail', 'unsubscribeTokenId', 'scheduledLocalDate',
      'windowStart', 'windowEnd', 'status',
      'sentAt', 'providerMessageId', 'runLeaseUntil', 'attemptCount',
      'briefGenerationStatus', 'briefGenerationVersion', 'briefGenerationErrorCode',
    ]));
    expect(uniqueConstraints('DigestRun')).toContainEqual(['userId', 'scheduledLocalDate']);
    expect(fieldNames('DigestItem')).toEqual(expect.arrayContaining([
      'runId', 'contentKey', 'position', 'title', 'summary', 'reason', 'sourceUrl',
      'citationUrls', 'platform', 'publishedAt', 'evidence', 'uncertainty', 'followUp',
    ]));
    expect(fieldNames('DigestTestEmail')).toEqual(expect.arrayContaining([
      'userId', 'recipientEmail', 'idempotencyBucket', 'status',
      'providerMessageId', 'errorCode', 'attemptCount', 'runLeaseUntil',
    ]));
    expect(uniqueConstraints('DigestTestEmail')).toContainEqual(['userId', 'idempotencyBucket']);
    expect(modelNames()).toContain('EmailDeliveryEvent');
    expect(fieldNames('EmailDeliveryEvent')).toEqual(expect.arrayContaining([
      'provider', 'providerEventId', 'eventType', 'outcome',
      'providerMessageId', 'occurredAt', 'createdAt',
    ]));
    expect(uniqueConstraints('EmailDeliveryEvent')).toContainEqual([
      'provider', 'providerEventId',
    ]);

    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations',
      '20260808_digest_preferences_preview', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    expect(migration).toContain('CREATE TABLE "DigestPreference"');
    expect(migration).toContain('CREATE TABLE "DigestRun"');
    expect(migration).toContain('CREATE TABLE "DigestItem"');
    const citationMigrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260810_digest_citations', 'migration.sql',
    );
    const citationMigration = existsSync(citationMigrationPath)
      ? readFileSync(citationMigrationPath, 'utf8') : '';
    expect(citationMigration).toContain('ADD COLUMN "citationUrls"');
    expect(citationMigration).toContain('ADD COLUMN "platform"');
    const generationMigrationPath = join(
      process.cwd(), 'prisma', 'migrations',
      '20260810_digest_brief_generation', 'migration.sql',
    );
    const generationMigration = existsSync(generationMigrationPath)
      ? readFileSync(generationMigrationPath, 'utf8') : '';
    expect(generationMigration).toContain('ALTER TYPE "AiRunKind" ADD VALUE \'digest\'');
    const unsubscribeMigrationPath = join(
      process.cwd(), 'prisma', 'migrations',
      '20260812_digest_unsubscribe', 'migration.sql',
    );
    const unsubscribeMigration = existsSync(unsubscribeMigrationPath)
      ? readFileSync(unsubscribeMigrationPath, 'utf8') : '';
    expect(unsubscribeMigration).toContain('ADD COLUMN "unsubscribeTokenId"');
    expect(unsubscribeMigration).toContain('DigestPreference_unsubscribeTokenId_key');
    expect(generationMigration).toContain('ALTER TYPE "AiTask" ADD VALUE \'digest_brief\'');
    expect(generationMigration).toContain('ADD COLUMN "briefGenerationStatus"');
    const recipientSnapshotMigrationPath = join(
      process.cwd(), 'prisma', 'migrations',
      '20260812_digest_run_recipient_snapshot', 'migration.sql',
    );
    const recipientSnapshotMigration = existsSync(recipientSnapshotMigrationPath)
      ? readFileSync(recipientSnapshotMigrationPath, 'utf8') : '';
    expect(recipientSnapshotMigration).toContain('ADD COLUMN "recipientEmail"');
    expect(recipientSnapshotMigration).toContain('SET "enabled" = false');
    const testEmailMigrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260812_digest_test_email', 'migration.sql',
    );
    const testEmailMigration = existsSync(testEmailMigrationPath)
      ? readFileSync(testEmailMigrationPath, 'utf8') : '';
    expect(testEmailMigration).toContain('CREATE TABLE "DigestTestEmail"');
    expect(testEmailMigration).toContain('DigestTestEmail_userId_idempotencyBucket_key');
    const suppressionMigrationPath = join(
      process.cwd(), 'prisma', 'migrations',
      '20260812_email_delivery_suppression', 'migration.sql',
    );
    const suppressionMigration = existsSync(suppressionMigrationPath)
      ? readFileSync(suppressionMigrationPath, 'utf8') : '';
    expect(suppressionMigration).toContain('ADD COLUMN "recipientSuppressionReason"');
    expect(suppressionMigration).toContain('ADD COLUMN "providerMessageId"');
    expect(suppressionMigration).toContain('CREATE TABLE "EmailDeliveryEvent"');
    expect(suppressionMigration).toContain('EmailDeliveryEvent_provider_providerEventId_key');
  });

  it('stores rebuildable profiles and versioned shadow recommendation decisions', () => {
    expect(modelNames()).toEqual(expect.arrayContaining([
      'UserInterestProfile', 'InterestProfileVersion',
      'RecommendationDecision', 'RecommendationDecisionItem', 'FeedImpression',
    ]));
    expect(fieldNames('UserInterestProfile')).toEqual(expect.arrayContaining([
      'userId', 'tagId', 'shortScore', 'longScore', 'negativeScore',
      'evidenceUpdatedAt', 'computedAt', 'profileVersion',
    ]));
    expect(fieldNames('InterestProfileVersion')).toEqual(expect.arrayContaining([
      'userId', 'version', 'throughEventId', 'computedAt', 'policyVersion',
    ]));
    expect(fieldNames('RecommendationDecision')).toEqual(expect.arrayContaining([
      'userId', 'surface', 'requestKey', 'profileVersion', 'rankingVersion',
      'candidateVersion', 'asOf', 'createdAt',
    ]));
    expect(uniqueConstraints('RecommendationDecision')).toContainEqual([
      'userId', 'surface', 'requestKey',
    ]);
    expect(fieldNames('RecommendationDecisionItem')).toEqual(expect.arrayContaining([
      'decisionId', 'contentKey', 'position', 'lane', 'isExploration', 'reasonCodes',
    ]));
    expect(fieldNames('FeedImpression')).toEqual(expect.arrayContaining([
      'userId', 'decisionId', 'contentKey', 'position', 'surface', 'bucketStart', 'shownAt',
    ]));
    expect(uniqueConstraints('FeedImpression')).toContainEqual([
      'userId', 'decisionId', 'contentKey', 'bucketStart',
    ]);

    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations',
      '20260808_interest_memory_a2_shadow', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    expect(migration).toContain('CREATE TABLE "UserInterestProfile"');
    expect(migration).toContain('CREATE TABLE "InterestProfileVersion"');
    expect(migration).toContain('CREATE TABLE "RecommendationDecision"');
    expect(migration).toContain('CREATE TABLE "RecommendationDecisionItem"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "RecommendationDecision_userId_surface_requestKey_key"',
    );
    const impressionMigrationPath = join(
      process.cwd(), 'prisma', 'migrations', '20260810_feed_impressions', 'migration.sql',
    );
    const impressionMigration = existsSync(impressionMigrationPath)
      ? readFileSync(impressionMigrationPath, 'utf8') : '';
    expect(impressionMigration).toContain('CREATE TABLE "FeedImpression"');
    expect(impressionMigration).toContain(
      'FeedImpression_userId_decisionId_contentKey_bucketStart_key',
    );
  });

  it('stores user-owned personalization controls separately from interest history', () => {
    expect(modelNames()).toEqual(expect.arrayContaining([
      'InterestMemorySettings', 'ForgottenInterestTag',
    ]));
    expect(fieldNames('InterestMemorySettings')).toEqual(expect.arrayContaining([
      'userId', 'personalizationEnabled', 'resetAt', 'updatedAt',
    ]));
    expect(fieldNames('ForgottenInterestTag')).toEqual(expect.arrayContaining([
      'userId', 'tagId', 'createdAt',
    ]));
    expect(fieldNames('UserInterestProfile')).toContain('sourceKinds');
    expect(relation('ForgottenInterestTag', 'user')).toMatchObject({
      relationFromFields: ['userId'], relationOnDelete: 'Cascade',
    });
    const migrationPath = join(
      process.cwd(), 'prisma', 'migrations',
      '20260808_interest_memory_a3_controls', 'migration.sql',
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
    expect(migration).toContain('CREATE TABLE "InterestMemorySettings"');
    expect(migration).toContain('CREATE TABLE "ForgottenInterestTag"');
    expect(migration).toContain(
      'ALTER TABLE "UserInterestProfile" ADD COLUMN "sourceKinds" TEXT[]',
    );
    const backfillPath = join(
      process.cwd(), 'prisma', 'migrations',
      '20260808_interest_memory_a3_fact_backfill', 'migration.sql',
    );
    const backfill = existsSync(backfillPath) ? readFileSync(backfillPath, 'utf8') : '';
    expect(backfill).toContain("'backfill-topic-' || topic.\"id\"");
    expect(backfill).toContain("'backfill-creator-' || creator.\"id\"");
    expect(backfill).toContain("'backfill-feedback-' || feedback.\"id\"");
    expect(backfill.match(/ON CONFLICT \("userId", "eventType", "activeKey"\) DO NOTHING;/g))
      .toHaveLength(3);
  });
});
