-- CreateEnum
CREATE TYPE "RecommendationSurface" AS ENUM ('feed', 'digest');

-- CreateEnum
CREATE TYPE "RecommendationLane" AS ENUM ('subscription', 'interest', 'trend', 'exploration');

-- CreateTable
CREATE TABLE "InterestProfileVersion" (
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "throughEventId" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "policyVersion" TEXT NOT NULL,
    CONSTRAINT "InterestProfileVersion_pkey" PRIMARY KEY ("userId", "version")
);

-- CreateTable
CREATE TABLE "UserInterestProfile" (
    "userId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "shortScore" DOUBLE PRECISION NOT NULL,
    "longScore" DOUBLE PRECISION NOT NULL,
    "negativeScore" DOUBLE PRECISION NOT NULL,
    "evidenceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "profileVersion" TEXT NOT NULL,
    CONSTRAINT "UserInterestProfile_pkey" PRIMARY KEY ("userId", "tagId")
);

-- CreateTable
CREATE TABLE "RecommendationDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surface" "RecommendationSurface" NOT NULL,
    "requestKey" TEXT NOT NULL,
    "profileVersion" TEXT NOT NULL,
    "rankingVersion" TEXT NOT NULL,
    "candidateVersion" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecommendationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationDecisionItem" (
    "decisionId" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "lane" "RecommendationLane" NOT NULL,
    "isExploration" BOOLEAN NOT NULL,
    "reasonCodes" TEXT[] NOT NULL,
    CONSTRAINT "RecommendationDecisionItem_pkey" PRIMARY KEY ("decisionId", "contentKey")
);

-- CreateIndex
CREATE INDEX "InterestProfileVersion_userId_computedAt_idx" ON "InterestProfileVersion"("userId", "computedAt");
CREATE INDEX "UserInterestProfile_userId_shortScore_idx" ON "UserInterestProfile"("userId", "shortScore");
CREATE INDEX "UserInterestProfile_userId_longScore_idx" ON "UserInterestProfile"("userId", "longScore");
CREATE INDEX "UserInterestProfile_userId_negativeScore_idx" ON "UserInterestProfile"("userId", "negativeScore");
CREATE UNIQUE INDEX "RecommendationDecision_userId_surface_requestKey_key" ON "RecommendationDecision"("userId", "surface", "requestKey");
CREATE INDEX "RecommendationDecision_userId_createdAt_idx" ON "RecommendationDecision"("userId", "createdAt");
CREATE INDEX "RecommendationDecision_userId_profileVersion_idx" ON "RecommendationDecision"("userId", "profileVersion");
CREATE UNIQUE INDEX "RecommendationDecisionItem_decisionId_position_key" ON "RecommendationDecisionItem"("decisionId", "position");
CREATE INDEX "RecommendationDecisionItem_contentKey_idx" ON "RecommendationDecisionItem"("contentKey");

-- AddForeignKey
ALTER TABLE "InterestProfileVersion" ADD CONSTRAINT "InterestProfileVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserInterestProfile" ADD CONSTRAINT "UserInterestProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserInterestProfile" ADD CONSTRAINT "UserInterestProfile_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "InterestTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserInterestProfile" ADD CONSTRAINT "UserInterestProfile_userId_profileVersion_fkey" FOREIGN KEY ("userId", "profileVersion") REFERENCES "InterestProfileVersion"("userId", "version") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationDecision" ADD CONSTRAINT "RecommendationDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationDecision" ADD CONSTRAINT "RecommendationDecision_userId_profileVersion_fkey" FOREIGN KEY ("userId", "profileVersion") REFERENCES "InterestProfileVersion"("userId", "version") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationDecisionItem" ADD CONSTRAINT "RecommendationDecisionItem_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "RecommendationDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
