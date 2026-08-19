-- User-owned reading-list state. A removal is retained so saved-only Feed
-- snapshots can remain stable while a user changes their current list.
CREATE TABLE "SavedContent" (
    "userId" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    CONSTRAINT "SavedContent_pkey" PRIMARY KEY ("userId", "contentKey")
);

CREATE INDEX "SavedContent_userId_savedAt_idx"
  ON "SavedContent"("userId", "savedAt");
CREATE INDEX "SavedContent_userId_removedAt_savedAt_idx"
  ON "SavedContent"("userId", "removedAt", "savedAt");

ALTER TABLE "SavedContent"
  ADD CONSTRAINT "SavedContent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
