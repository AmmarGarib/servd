-- Dual contact verification: every customer account is verified on email as
-- well as phone, so a dropped WhatsApp session is a degradation, not an outage.

ALTER TABLE "customers" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

ALTER TABLE "magic_links" ADD COLUMN "channel" TEXT;

CREATE TABLE "email_otps" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "customerId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_otps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_otps_email_purpose_createdAt_idx" ON "email_otps"("email", "purpose", "createdAt");
