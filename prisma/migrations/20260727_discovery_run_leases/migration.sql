-- Add recoverable run ownership and one-slot manual refresh state.
ALTER TABLE "Topic"
ADD COLUMN "activeRunId" TEXT,
ADD COLUMN "runLeaseUntil" TIMESTAMP(3),
ADD COLUMN "manualRefreshPending" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Topic_runStatus_runLeaseUntil_idx" ON "Topic"("runStatus", "runLeaseUntil");
