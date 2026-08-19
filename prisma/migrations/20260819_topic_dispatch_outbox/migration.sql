-- Persist Topic dispatch intent in the same transaction as the Topic state change.
CREATE TABLE "TopicDispatchOutbox" (
  "id" TEXT NOT NULL,
  "topicId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "trigger" "DiscoveryTrigger" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimUntil" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "dispatchedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,

  CONSTRAINT "TopicDispatchOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TopicDispatchOutbox_dispatchedAt_availableAt_claimUntil_createdAt_idx"
  ON "TopicDispatchOutbox"("dispatchedAt", "availableAt", "claimUntil", "createdAt");
CREATE INDEX "TopicDispatchOutbox_topicId_dispatchedAt_idx"
  ON "TopicDispatchOutbox"("topicId", "dispatchedAt");

ALTER TABLE "TopicDispatchOutbox"
  ADD CONSTRAINT "TopicDispatchOutbox_topicId_fkey"
  FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
