ALTER TABLE "DigestPreference"
ADD COLUMN "recipientSuppressionReason" TEXT,
ADD COLUMN "recipientSuppressedAt" TIMESTAMP(3);

ALTER TABLE "DigestEmailVerification"
ADD COLUMN "providerMessageId" TEXT;

CREATE INDEX "DigestEmailVerification_providerMessageId_idx"
ON "DigestEmailVerification"("providerMessageId");

CREATE INDEX "DigestTestEmail_providerMessageId_idx"
ON "DigestTestEmail"("providerMessageId");

CREATE INDEX "DigestRun_providerMessageId_idx"
ON "DigestRun"("providerMessageId");

CREATE TABLE "EmailDeliveryEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailDeliveryEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailDeliveryEvent_provider_providerEventId_key"
ON "EmailDeliveryEvent"("provider", "providerEventId");

CREATE INDEX "EmailDeliveryEvent_providerMessageId_idx"
ON "EmailDeliveryEvent"("providerMessageId");

CREATE INDEX "EmailDeliveryEvent_createdAt_idx"
ON "EmailDeliveryEvent"("createdAt");
