ALTER TABLE "DigestPreference"
ADD COLUMN "recipientEmail" TEXT,
ADD COLUMN "recipientStatus" TEXT NOT NULL DEFAULT 'unverified',
ADD COLUMN "recipientVerifiedAt" TIMESTAMP(3);

CREATE TABLE "DigestEmailVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestEmailVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DigestEmailVerification_tokenHash_key"
ON "DigestEmailVerification"("tokenHash");

CREATE INDEX "DigestEmailVerification_userId_createdAt_idx"
ON "DigestEmailVerification"("userId", "createdAt");

CREATE INDEX "DigestEmailVerification_expiresAt_idx"
ON "DigestEmailVerification"("expiresAt");

ALTER TABLE "DigestEmailVerification"
ADD CONSTRAINT "DigestEmailVerification_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
