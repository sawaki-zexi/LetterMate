ALTER TYPE "AiRunKind" ADD VALUE 'digest';
ALTER TYPE "AiTask" ADD VALUE 'digest_brief';

ALTER TABLE "DigestRun"
  ADD COLUMN "briefGenerationStatus" TEXT NOT NULL DEFAULT 'fallback',
  ADD COLUMN "briefGenerationVersion" TEXT NOT NULL DEFAULT 'digest-brief-fallback-v1',
  ADD COLUMN "briefGenerationErrorCode" TEXT;
