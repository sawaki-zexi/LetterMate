-- Reading-list records are versioned so Feed snapshots can replay state after
-- repeated save, archive, restore, and remove transitions.
CREATE TYPE "SavedContentState" AS ENUM ('saved', 'archived');

ALTER TABLE "SavedContent"
  ADD COLUMN "id" TEXT,
  ADD COLUMN "state" "SavedContentState" NOT NULL DEFAULT 'saved';

UPDATE "SavedContent"
SET "id" = gen_random_uuid()::text;

ALTER TABLE "SavedContent"
  ALTER COLUMN "id" SET NOT NULL,
  DROP CONSTRAINT "SavedContent_pkey",
  ADD CONSTRAINT "SavedContent_pkey" PRIMARY KEY ("id");

DROP INDEX "SavedContent_userId_removedAt_savedAt_idx";

CREATE INDEX "SavedContent_userId_state_removedAt_savedAt_idx"
  ON "SavedContent"("userId", "state", "removedAt", "savedAt");
CREATE INDEX "SavedContent_userId_contentKey_removedAt_idx"
  ON "SavedContent"("userId", "contentKey", "removedAt");
CREATE UNIQUE INDEX "SavedContent_one_active_state_per_content_idx"
  ON "SavedContent"("userId", "contentKey")
  WHERE "removedAt" IS NULL;
