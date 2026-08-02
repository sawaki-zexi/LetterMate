ALTER TABLE "Topic"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "variantsInitialized" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "DiscoveryRun"
  ADD COLUMN "keywordSnapshot" TEXT,
  ADD COLUMN "expandedTermsSnapshot" TEXT[];

ALTER TABLE "DiscoveryItem"
  ADD COLUMN "topicKeyword" TEXT;

UPDATE "DiscoveryRun" AS "run"
SET
  "keywordSnapshot" = "topic"."keyword",
  "expandedTermsSnapshot" = "topic"."expandedTerms"
FROM "Topic" AS "topic"
WHERE "run"."topicId" = "topic"."id";

UPDATE "DiscoveryItem" AS "item"
SET "topicKeyword" = "topic"."keyword"
FROM "Topic" AS "topic"
WHERE "item"."topicId" = "topic"."id";

ALTER TABLE "DiscoveryRun"
  ALTER COLUMN "keywordSnapshot" SET NOT NULL;

ALTER TABLE "DiscoveryRun"
  ALTER COLUMN "expandedTermsSnapshot" SET DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "DiscoveryRun"
  ALTER COLUMN "expandedTermsSnapshot" SET NOT NULL;

ALTER TABLE "DiscoveryItem"
  ALTER COLUMN "topicKeyword" SET NOT NULL;

DROP INDEX "Topic_userId_normalizedKeyword_key";

CREATE UNIQUE INDEX "Topic_userId_normalizedKeyword_active_key"
  ON "Topic"("userId", "normalizedKeyword")
  WHERE "deletedAt" IS NULL;

CREATE INDEX "Topic_userId_deletedAt_createdAt_idx"
  ON "Topic"("userId", "deletedAt", "createdAt");
