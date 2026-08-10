-- Distinguish a usable creator sync with one or more restricted source streams.
ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'degraded';

ALTER TABLE "CreatorSubscription"
  ADD COLUMN "degradedSources" JSONB;

ALTER TABLE "CreatorRun"
  ADD COLUMN "degradedSources" JSONB;
