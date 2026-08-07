-- AlterTable
ALTER TABLE "UserInterestProfile" ADD COLUMN "sourceKinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "InterestMemorySettings" (
    "userId" TEXT NOT NULL,
    "personalizationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "resetAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InterestMemorySettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ForgottenInterestTag" (
    "userId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForgottenInterestTag_pkey" PRIMARY KEY ("userId", "tagId")
);

-- CreateIndex
CREATE INDEX "ForgottenInterestTag_userId_createdAt_idx" ON "ForgottenInterestTag"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "InterestMemorySettings" ADD CONSTRAINT "InterestMemorySettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ForgottenInterestTag" ADD CONSTRAINT "ForgottenInterestTag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ForgottenInterestTag" ADD CONSTRAINT "ForgottenInterestTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "InterestTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
