-- CreateEnum
CREATE TYPE "InterestEventType" AS ENUM ('topic_state', 'creator_state', 'feedback_state');

-- CreateEnum
CREATE TYPE "InterestTagKind" AS ENUM ('topic', 'entity', 'content_type');

-- CreateEnum
CREATE TYPE "InterestTagStatus" AS ENUM ('active', 'retired');

-- CreateTable
CREATE TABLE "InterestTag" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "parentId" TEXT,
    "kind" "InterestTagKind" NOT NULL,
    "status" "InterestTagStatus" NOT NULL DEFAULT 'active',
    "taxonomyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InterestTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentInterestTag" (
    "contentKey" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentInterestTag_pkey" PRIMARY KEY ("contentKey", "tagId", "extractorVersion")
);

-- CreateTable
CREATE TABLE "InterestEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" "InterestEventType" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "activeKey" TEXT,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    CONSTRAINT "InterestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterestTag_slug_taxonomyVersion_key" ON "InterestTag"("slug", "taxonomyVersion");
CREATE INDEX "InterestTag_parentId_idx" ON "InterestTag"("parentId");
CREATE INDEX "InterestTag_taxonomyVersion_status_idx" ON "InterestTag"("taxonomyVersion", "status");
CREATE INDEX "ContentInterestTag_contentKey_extractorVersion_idx" ON "ContentInterestTag"("contentKey", "extractorVersion");
CREATE INDEX "ContentInterestTag_tagId_createdAt_idx" ON "ContentInterestTag"("tagId", "createdAt");
CREATE UNIQUE INDEX "InterestEvent_userId_eventType_activeKey_key" ON "InterestEvent"("userId", "eventType", "activeKey");
CREATE INDEX "InterestEvent_userId_occurredAt_idx" ON "InterestEvent"("userId", "occurredAt");
CREATE INDEX "InterestEvent_userId_eventType_sourceRef_occurredAt_idx" ON "InterestEvent"("userId", "eventType", "sourceRef", "occurredAt");

-- AddForeignKey
ALTER TABLE "InterestTag" ADD CONSTRAINT "InterestTag_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "InterestTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContentInterestTag" ADD CONSTRAINT "ContentInterestTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "InterestTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterestEvent" ADD CONSTRAINT "InterestEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
