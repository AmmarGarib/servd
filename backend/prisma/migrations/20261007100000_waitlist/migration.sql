-- Waitlist (owner, 2026-10-07): a general servd "new brand" list. Sign-ups link to the
-- customer master record (WhatsApp-verified, consent recorded); visits are anonymous.
-- CreateTable
CREATE TABLE "waitlist_signups" (
    "id" TEXT NOT NULL,
    "list" TEXT NOT NULL DEFAULT 'servd_new_brand',
    "customerId" TEXT NOT NULL,
    "source" TEXT,
    "area" TEXT,
    "interest" TEXT,
    "consentText" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitlist_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_visits" (
    "id" TEXT NOT NULL,
    "list" TEXT NOT NULL DEFAULT 'servd_new_brand',
    "source" TEXT,
    "device" TEXT,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_signups_list_createdAt_idx" ON "waitlist_signups"("list", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_signups_list_customerId_key" ON "waitlist_signups"("list", "customerId");

-- CreateIndex
CREATE INDEX "waitlist_visits_list_createdAt_idx" ON "waitlist_visits"("list", "createdAt");

-- AddForeignKey
ALTER TABLE "waitlist_signups" ADD CONSTRAINT "waitlist_signups_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

