ALTER TABLE "Topic" ADD COLUMN "queuedTrigger" "DiscoveryTrigger";

UPDATE "Topic"
SET "queuedTrigger" = (CASE WHEN "nextRunAt" IS NULL THEN 'initial' ELSE 'scheduled' END)::"DiscoveryTrigger"
WHERE "runStatus" = 'queued' AND "queuedTrigger" IS NULL;
