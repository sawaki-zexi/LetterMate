ALTER TABLE "DigestRun"
ADD COLUMN "recipientEmail" TEXT;

UPDATE "DigestPreference"
SET "enabled" = false
WHERE "recipientStatus" <> 'verified'
   OR "recipientEmail" IS NULL;

UPDATE "DigestRun"
SET "status" = 'failed',
    "finishedAt" = COALESCE("finishedAt", CURRENT_TIMESTAMP),
    "runLeaseUntil" = NULL,
    "error" = '{"code":"DIGEST_RECIPIENT_NOT_FROZEN","message":"Daily digest delivery requires a verified frozen recipient"}'::jsonb
WHERE "status" IN ('queued', 'running');
