ALTER TYPE "CreatorPlatform" ADD VALUE 'x';

CREATE TYPE "CreatorContentType" AS ENUM ('original', 'repost', 'reply');

ALTER TABLE "CreatorSubscription" ALTER COLUMN "feedUrl" DROP NOT NULL;

ALTER TABLE "CreatorItem"
    ADD COLUMN "contentType" "CreatorContentType" NOT NULL DEFAULT 'original',
    ADD COLUMN "originalAuthorName" TEXT,
    ADD COLUMN "originalAuthorHandle" TEXT,
    ADD COLUMN "originalContentId" TEXT,
    ADD COLUMN "originalContentUrl" TEXT,
    ADD COLUMN "parentContentId" TEXT,
    ADD COLUMN "parentContentUrl" TEXT,
    ADD COLUMN "parentContentText" TEXT;
