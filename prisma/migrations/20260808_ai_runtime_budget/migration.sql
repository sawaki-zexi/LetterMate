CREATE TYPE "AiRunKind" AS ENUM ('topic', 'trend', 'creator');
CREATE TYPE "AiTask" AS ENUM (
  'topic_expansion',
  'trend_classification',
  'candidate_assessment',
  'item_composition',
  'item_chinese_repair',
  'creator_localization',
  'interest_tagging'
);
CREATE TYPE "AiUsageStatus" AS ENUM ('reserved', 'succeeded', 'failed');

CREATE TABLE "AiRunBudget" (
  "runKind" "AiRunKind" NOT NULL,
  "runId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "budgetVersion" TEXT NOT NULL,
  "maxCalls" INTEGER NOT NULL,
  "maxInputTokens" INTEGER NOT NULL,
  "maxOutputTokens" INTEGER NOT NULL,
  "maxCostMicros" INTEGER NOT NULL,
  "reservedCalls" INTEGER NOT NULL DEFAULT 0,
  "reservedInputTokens" INTEGER NOT NULL DEFAULT 0,
  "reservedOutputTokens" INTEGER NOT NULL DEFAULT 0,
  "reservedCostMicros" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiRunBudget_pkey" PRIMARY KEY ("runKind", "runId")
);

CREATE TABLE "AiUsage" (
  "id" TEXT NOT NULL,
  "runKind" "AiRunKind" NOT NULL,
  "runId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "task" "AiTask" NOT NULL,
  "status" "AiUsageStatus" NOT NULL DEFAULT 'reserved',
  "routeVersion" TEXT NOT NULL,
  "requestedModel" TEXT NOT NULL,
  "actualModel" TEXT,
  "provider" TEXT,
  "estimatedInputTokens" INTEGER NOT NULL,
  "reservedOutputTokens" INTEGER NOT NULL,
  "reservedCostMicros" INTEGER NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "reasoningTokens" INTEGER,
  "cachedTokens" INTEGER,
  "costMicros" INTEGER,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiRunBudget_userId_createdAt_idx" ON "AiRunBudget"("userId", "createdAt");
CREATE INDEX "AiUsage_userId_createdAt_idx" ON "AiUsage"("userId", "createdAt");
CREATE INDEX "AiUsage_runKind_runId_createdAt_idx" ON "AiUsage"("runKind", "runId", "createdAt");
CREATE INDEX "AiUsage_status_createdAt_idx" ON "AiUsage"("status", "createdAt");

ALTER TABLE "AiRunBudget"
  ADD CONSTRAINT "AiRunBudget_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiUsage"
  ADD CONSTRAINT "AiUsage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiUsage"
  ADD CONSTRAINT "AiUsage_runKind_runId_fkey"
  FOREIGN KEY ("runKind", "runId") REFERENCES "AiRunBudget"("runKind", "runId")
  ON DELETE CASCADE ON UPDATE CASCADE;
