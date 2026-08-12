CREATE TABLE "DigestTestEmail" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "idempotencyBucket" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "runLeaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DigestTestEmail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DigestTestEmail_userId_idempotencyBucket_key"
ON "DigestTestEmail"("userId", "idempotencyBucket");

CREATE INDEX "DigestTestEmail_userId_createdAt_idx"
ON "DigestTestEmail"("userId", "createdAt");

CREATE INDEX "DigestTestEmail_status_runLeaseUntil_idx"
ON "DigestTestEmail"("status", "runLeaseUntil");

ALTER TABLE "DigestTestEmail"
ADD CONSTRAINT "DigestTestEmail_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
