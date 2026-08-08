CREATE TYPE "RunStageName" AS ENUM (
  'plan', 'retrieve', 'enrich', 'assess', 'followup', 'compose', 'quality_gate', 'persist'
);
CREATE TYPE "RunStageStatus" AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE "RunStage" (
  "id" TEXT NOT NULL,
  "runKind" "AiRunKind" NOT NULL,
  "runId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "stage" "RunStageName" NOT NULL,
  "status" "RunStageStatus" NOT NULL DEFAULT 'running',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "inputDigest" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL DEFAULT '',
  "routeVersion" TEXT NOT NULL DEFAULT '',
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RunStage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunArtifact" (
  "id" TEXT NOT NULL,
  "stageId" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RunArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RunStage_runKind_runId_stage_inputDigest_policyVersion_routeVersion_key"
  ON "RunStage"("runKind", "runId", "stage", "inputDigest", "policyVersion", "routeVersion");
CREATE INDEX "RunStage_userId_createdAt_idx" ON "RunStage"("userId", "createdAt");
CREATE INDEX "RunStage_runKind_runId_stage_status_idx"
  ON "RunStage"("runKind", "runId", "stage", "status");
CREATE UNIQUE INDEX "RunArtifact_stageId_key" ON "RunArtifact"("stageId");

ALTER TABLE "RunStage"
  ADD CONSTRAINT "RunStage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunArtifact"
  ADD CONSTRAINT "RunArtifact_stageId_fkey"
  FOREIGN KEY ("stageId") REFERENCES "RunStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
