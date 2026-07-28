-- CreateEnum
CREATE TYPE "DiscoveryTrigger" AS ENUM ('initial', 'manual', 'scheduled');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('web', 'feed', 'social', 'video', 'community', 'code', 'paper');

-- CreateEnum
CREATE TYPE "ProvenanceKind" AS ENUM ('ai_citation', 'api_record', 'feed_entry', 'fetched_page');

-- AlterTable
ALTER TABLE "Topic"
ADD COLUMN "nextRunAt" TIMESTAMP(3),
ADD COLUMN "scheduleIntervalHours" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN "productiveRunStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "emptyRunStreak" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DiscoveryItem"
ADD COLUMN "sourceType" "SourceType" NOT NULL DEFAULT 'web',
ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'Web',
ADD COLUMN "authorName" TEXT,
ADD COLUMN "authorHandle" TEXT,
ADD COLUMN "externalId" TEXT,
ADD COLUMN "provenanceKind" "ProvenanceKind" NOT NULL DEFAULT 'ai_citation';

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "trigger" "DiscoveryTrigger" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "connectorSummary" JSONB,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "newItemCount" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Topic_nextRunAt_runStatus_idx" ON "Topic"("nextRunAt", "runStatus");

-- CreateIndex
CREATE INDEX "DiscoveryRun_topicId_startedAt_idx" ON "DiscoveryRun"("topicId", "startedAt");

-- CreateIndex
CREATE INDEX "DiscoveryRun_status_startedAt_idx" ON "DiscoveryRun"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
