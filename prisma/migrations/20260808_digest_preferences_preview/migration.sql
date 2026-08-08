-- CreateEnum
CREATE TYPE "DigestRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'skipped', 'failed');

-- CreateTable
CREATE TABLE "DigestPreference" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "localSendTime" TEXT NOT NULL DEFAULT '08:00',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DigestPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "DigestRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scheduledLocalDate" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "DigestRunStatus" NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "error" JSONB,
    "runLeaseUntil" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DigestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestItem" (
    "runId" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    CONSTRAINT "DigestItem_pkey" PRIMARY KEY ("runId", "contentKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "DigestRun_userId_scheduledLocalDate_key" ON "DigestRun"("userId", "scheduledLocalDate");
CREATE INDEX "DigestRun_status_runLeaseUntil_idx" ON "DigestRun"("status", "runLeaseUntil");
CREATE INDEX "DigestRun_userId_windowEnd_idx" ON "DigestRun"("userId", "windowEnd");
CREATE UNIQUE INDEX "DigestItem_runId_position_key" ON "DigestItem"("runId", "position");
CREATE INDEX "DigestItem_contentKey_idx" ON "DigestItem"("contentKey");

-- AddForeignKey
ALTER TABLE "DigestPreference" ADD CONSTRAINT "DigestPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigestRun" ADD CONSTRAINT "DigestRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigestItem" ADD CONSTRAINT "DigestItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DigestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
