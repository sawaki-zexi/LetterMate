CREATE TABLE "FeedImpression" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "surface" "RecommendationSurface" NOT NULL DEFAULT 'feed',
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "shownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedImpression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeedImpression_userId_decisionId_contentKey_bucketStart_key"
  ON "FeedImpression"("userId", "decisionId", "contentKey", "bucketStart");
CREATE INDEX "FeedImpression_userId_surface_shownAt_idx"
  ON "FeedImpression"("userId", "surface", "shownAt");
CREATE INDEX "FeedImpression_contentKey_shownAt_idx"
  ON "FeedImpression"("contentKey", "shownAt");

ALTER TABLE "FeedImpression"
  ADD CONSTRAINT "FeedImpression_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedImpression"
  ADD CONSTRAINT "FeedImpression_decisionId_fkey"
  FOREIGN KEY ("decisionId") REFERENCES "RecommendationDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
