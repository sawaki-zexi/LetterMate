-- Restore the adjacency relation after InterestTag and ContentInterestTag exist.
CREATE TABLE IF NOT EXISTS "InterestTagAdjacency" (
    "leftTagId" TEXT NOT NULL,
    "rightTagId" TEXT NOT NULL,
    "relationVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InterestTagAdjacency_pkey" PRIMARY KEY ("leftTagId", "rightTagId", "relationVersion")
);

CREATE INDEX IF NOT EXISTS "InterestTagAdjacency_leftTagId_relationVersion_idx"
  ON "InterestTagAdjacency"("leftTagId", "relationVersion");
CREATE INDEX IF NOT EXISTS "InterestTagAdjacency_rightTagId_relationVersion_idx"
  ON "InterestTagAdjacency"("rightTagId", "relationVersion");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InterestTagAdjacency_leftTagId_fkey'
  ) THEN
    ALTER TABLE "InterestTagAdjacency"
      ADD CONSTRAINT "InterestTagAdjacency_leftTagId_fkey"
      FOREIGN KEY ("leftTagId") REFERENCES "InterestTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InterestTagAdjacency_rightTagId_fkey'
  ) THEN
    ALTER TABLE "InterestTagAdjacency"
      ADD CONSTRAINT "InterestTagAdjacency_rightTagId_fkey"
      FOREIGN KEY ("rightTagId") REFERENCES "InterestTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill adjacency from high-confidence, current-version tags on qualified content.
INSERT INTO "InterestTagAdjacency" ("leftTagId", "rightTagId", "relationVersion")
SELECT DISTINCT
    LEAST(left_content."tagId", right_content."tagId"),
    GREATEST(left_content."tagId", right_content."tagId"),
    'qualified-content-cooccurrence-v1'
FROM "ContentInterestTag" AS left_content
INNER JOIN "ContentInterestTag" AS right_content
    ON right_content."contentKey" = left_content."contentKey"
    AND right_content."extractorVersion" = left_content."extractorVersion"
    AND right_content."tagId" > left_content."tagId"
INNER JOIN "InterestTag" AS left_tag ON left_tag."id" = left_content."tagId"
INNER JOIN "InterestTag" AS right_tag ON right_tag."id" = right_content."tagId"
WHERE left_content."extractorVersion" = 'openrouter-theme-v1'
  AND left_content."confidence" >= 0.75
  AND right_content."confidence" >= 0.75
  AND left_tag."taxonomyVersion" = '2026-08-08-v1'
  AND right_tag."taxonomyVersion" = '2026-08-08-v1'
  AND left_tag."status" = 'active'
  AND right_tag."status" = 'active'
  AND left_tag."kind" <> 'content_type'
  AND right_tag."kind" <> 'content_type'
ON CONFLICT DO NOTHING;
