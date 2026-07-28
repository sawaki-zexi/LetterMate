BEGIN;

-- Prevent new duplicate seeds while existing duplicates are reconciled.
LOCK TABLE "TrendSeed" IN SHARE ROW EXCLUSIVE MODE;

-- Keep the earliest discovered row, using the primary key as a deterministic tie-breaker.
DELETE FROM "TrendSeed" AS "duplicate"
USING "TrendSeed" AS "retained"
WHERE "duplicate"."runId" = "retained"."runId"
  AND "duplicate"."fingerprint" = "retained"."fingerprint"
  AND (
    "duplicate"."discoveredAt" > "retained"."discoveredAt"
    OR (
      "duplicate"."discoveredAt" = "retained"."discoveredAt"
      AND "duplicate"."id" > "retained"."id"
    )
  );

CREATE UNIQUE INDEX "TrendSeed_runId_fingerprint_key"
ON "TrendSeed"("runId", "fingerprint");

COMMIT;
