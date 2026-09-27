-- Loyalty tiers are per company (owner decision 13): copy the shared ladder
-- to every company, then drop the shared rows.
ALTER TABLE "tier_configs" ADD COLUMN "tenantId" TEXT;
INSERT INTO "tier_configs" (id, "tenantId", tier, "displayName", rank, "isPaid", "monthlyPriceCents", "unlockSpendCents", "isActive", "alwaysFreeDelivery", "freeDeliveryAboveCents", "birthdayDiscountPct", "priorityReservationDays", "waitlistPriority", "monthlyCompCents", "earlyMenuAccess", "freeBirthdayItem", "customPerks", description, "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, t.id, c.tier, c."displayName", c.rank, c."isPaid", c."monthlyPriceCents", c."unlockSpendCents", c."isActive", c."alwaysFreeDelivery", c."freeDeliveryAboveCents", c."birthdayDiscountPct", c."priorityReservationDays", c."waitlistPriority", c."monthlyCompCents", c."earlyMenuAccess", c."freeBirthdayItem", c."customPerks", c.description, now(), now()
  FROM "tier_configs" c CROSS JOIN "tenants" t
  WHERE c."tenantId" IS NULL AND t."deletedAt" IS NULL;
DELETE FROM "tier_configs" WHERE "tenantId" IS NULL;
DROP INDEX IF EXISTS "tier_configs_tier_key";
CREATE UNIQUE INDEX "tier_configs_tenantId_tier_key" ON "tier_configs"("tenantId", "tier");

-- Bans apply at the company that raised them (owner decision 15).
ALTER TABLE "customer_bans" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "customer_bans_tenantId_customerId_idx" ON "customer_bans"("tenantId", "customerId");
UPDATE "customer_bans" b SET "tenantId" = u."tenantId" FROM "users" u WHERE b."bannedById" = u.id AND b."tenantId" IS NULL;
-- The old CRM blacklist becomes a ban that applies everywhere, as it did.
INSERT INTO "customer_bans" (id, "customerId", email, phone, reason, "bannedAt")
  SELECT gen_random_uuid()::text, c.id, lower(c.email), c.phone, COALESCE(c."blacklistReason", 'Blacklisted in CRM (migrated)'), now()
  FROM "customers" c
  WHERE c."isBlacklisted" = true
    AND NOT EXISTS (SELECT 1 FROM "customer_bans" b WHERE b."customerId" = c.id AND b."liftedAt" IS NULL AND (b."expiresAt" IS NULL OR b."expiresAt" > now()));
