ALTER TABLE "Topic"
  ADD COLUMN "pausedAt" TIMESTAMP(3);

CREATE INDEX "Topic_pausedAt_nextRunAt_idx"
  ON "Topic"("pausedAt", "nextRunAt");
