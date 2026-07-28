-- CreateTable
CREATE TABLE "TrendMonitor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runStatus" "RunStatus" NOT NULL DEFAULT 'queued',
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "intervalHours" INTEGER NOT NULL DEFAULT 4,
    "activeRunId" TEXT,
    "runLeaseUntil" TIMESTAMP(3),
    "manualRefreshPending" BOOLEAN NOT NULL DEFAULT false,
    "lastError" JSONB,

    CONSTRAINT "TrendMonitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "trigger" "DiscoveryTrigger" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "newItemCount" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,

    CONSTRAINT "TrendRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendSeed" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "normalizedQuery" TEXT NOT NULL,

    CONSTRAINT "TrendSeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadarItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "DiscoveryKind" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceUrls" TEXT[] NOT NULL,
    "canonicalPrimaryUrl" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sourceType" "SourceType" NOT NULL DEFAULT 'web',
    "platform" TEXT NOT NULL DEFAULT 'Web',
    "authorName" TEXT,
    "authorHandle" TEXT,
    "externalId" TEXT,
    "provenanceKind" "ProvenanceKind" NOT NULL DEFAULT 'ai_citation',

    CONSTRAINT "RadarItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrendMonitor_userId_key" ON "TrendMonitor"("userId");

-- CreateIndex
CREATE INDEX "TrendMonitor_nextRunAt_runStatus_idx" ON "TrendMonitor"("nextRunAt", "runStatus");

-- CreateIndex
CREATE INDEX "TrendMonitor_runStatus_runLeaseUntil_idx" ON "TrendMonitor"("runStatus", "runLeaseUntil");

-- CreateIndex
CREATE INDEX "TrendRun_userId_status_startedAt_idx" ON "TrendRun"("userId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "TrendRun_monitorId_startedAt_idx" ON "TrendRun"("monitorId", "startedAt");

-- CreateIndex
CREATE INDEX "TrendSeed_userId_fingerprint_discoveredAt_idx" ON "TrendSeed"("userId", "fingerprint", "discoveredAt");

-- CreateIndex
CREATE INDEX "TrendSeed_runId_discoveredAt_idx" ON "TrendSeed"("runId", "discoveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RadarItem_userId_canonicalPrimaryUrl_key" ON "RadarItem"("userId", "canonicalPrimaryUrl");

-- CreateIndex
CREATE INDEX "RadarItem_userId_publishedAt_discoveredAt_idx" ON "RadarItem"("userId", "publishedAt", "discoveredAt");

-- CreateIndex
CREATE INDEX "RadarItem_runId_discoveredAt_idx" ON "RadarItem"("runId", "discoveredAt");

-- AddForeignKey
ALTER TABLE "TrendMonitor" ADD CONSTRAINT "TrendMonitor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendRun" ADD CONSTRAINT "TrendRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendRun" ADD CONSTRAINT "TrendRun_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "TrendMonitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendSeed" ADD CONSTRAINT "TrendSeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendSeed" ADD CONSTRAINT "TrendSeed_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrendRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RadarItem" ADD CONSTRAINT "RadarItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RadarItem" ADD CONSTRAINT "RadarItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrendRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill one monitor for every existing user. PostgreSQL's core md5 function avoids requiring a UUID extension.
INSERT INTO "TrendMonitor" ("id", "userId", "runStatus", "nextRunAt", "intervalHours", "manualRefreshPending")
SELECT md5('trend-monitor:' || "id")::uuid::text, "id", 'queued', NOW(), 4, false FROM "User";
