ALTER TABLE "DigestPreference"
ADD COLUMN "unsubscribeTokenId" TEXT;

UPDATE "DigestPreference"
SET "unsubscribeTokenId" = gen_random_uuid()::text
WHERE "unsubscribeTokenId" IS NULL;

ALTER TABLE "DigestPreference"
ALTER COLUMN "unsubscribeTokenId" SET NOT NULL;

CREATE UNIQUE INDEX "DigestPreference_unsubscribeTokenId_key"
ON "DigestPreference"("unsubscribeTokenId");

ALTER TABLE "DigestRun"
ADD COLUMN "unsubscribeTokenId" TEXT;

UPDATE "DigestRun"
SET
  "status" = 'failed',
  "finishedAt" = CURRENT_TIMESTAMP,
  "runLeaseUntil" = NULL,
  "error" = '{"code":"DIGEST_UNSUBSCRIBE_SNAPSHOT_MISSING","message":"Digest run predates unsubscribe snapshot support"}'::jsonb
WHERE "status" IN ('queued', 'running')
  AND "unsubscribeTokenId" IS NULL;
