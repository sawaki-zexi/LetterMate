CREATE TYPE "KeywordProfileKind" AS ENUM ('entity', 'domain', 'unknown');

ALTER TABLE "Topic"
  ADD COLUMN "keywordProfile" "KeywordProfileKind" NOT NULL DEFAULT 'unknown';

ALTER TABLE "DiscoveryRun"
  ADD COLUMN "keywordProfileSnapshot" "KeywordProfileKind" NOT NULL DEFAULT 'unknown';
