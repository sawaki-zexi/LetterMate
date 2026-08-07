CREATE TYPE "CreatorPlatform" AS ENUM ('rss');

CREATE TABLE "CreatorSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "CreatorPlatform" NOT NULL,
    "accountKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "feedUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "runStatus" "RunStatus" NOT NULL DEFAULT 'queued',
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "activeRunId" TEXT,
    "runLeaseUntil" TIMESTAMP(3),
    "lastError" JSONB,
    CONSTRAINT "CreatorSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "trigger" "DiscoveryTrigger" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "newItemCount" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    CONSTRAINT "CreatorRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "kind" "DiscoveryKind" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceUrls" TEXT[],
    "canonicalPrimaryUrl" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sourceType" "SourceType" NOT NULL DEFAULT 'feed',
    "platform" TEXT NOT NULL DEFAULT 'RSS/Atom',
    "authorName" TEXT,
    "authorHandle" TEXT,
    "externalId" TEXT,
    "provenanceKind" "ProvenanceKind" NOT NULL DEFAULT 'feed_entry',
    "feedEligible" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "CreatorItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreatorSubscription_userId_pausedAt_nextRunAt_idx" ON "CreatorSubscription"("userId", "pausedAt", "nextRunAt");
CREATE INDEX "CreatorSubscription_runStatus_runLeaseUntil_idx" ON "CreatorSubscription"("runStatus", "runLeaseUntil");
CREATE UNIQUE INDEX "CreatorSubscription_userId_platform_accountKey_key" ON "CreatorSubscription"("userId", "platform", "accountKey");
CREATE INDEX "CreatorRun_userId_status_startedAt_idx" ON "CreatorRun"("userId", "status", "startedAt");
CREATE INDEX "CreatorRun_creatorId_startedAt_idx" ON "CreatorRun"("creatorId", "startedAt");
CREATE UNIQUE INDEX "CreatorRun_id_userId_key" ON "CreatorRun"("id", "userId");
CREATE INDEX "CreatorItem_userId_publishedAt_discoveredAt_idx" ON "CreatorItem"("userId", "publishedAt", "discoveredAt");
CREATE INDEX "CreatorItem_creatorId_publishedAt_discoveredAt_idx" ON "CreatorItem"("creatorId", "publishedAt", "discoveredAt");
CREATE UNIQUE INDEX "CreatorItem_creatorId_canonicalPrimaryUrl_key" ON "CreatorItem"("creatorId", "canonicalPrimaryUrl");

ALTER TABLE "CreatorSubscription" ADD CONSTRAINT "CreatorSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorRun" ADD CONSTRAINT "CreatorRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorRun" ADD CONSTRAINT "CreatorRun_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorItem" ADD CONSTRAINT "CreatorItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorItem" ADD CONSTRAINT "CreatorItem_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
