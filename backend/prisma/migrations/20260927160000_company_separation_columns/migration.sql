-- Company separation sweep (2026-09-27): every company-owned table carries tenantId.
-- Backfilled from the row's brand where one is set; rows with no brand stay NULL and the
-- API treats them as the owning company's defaults, never shared.

-- DropIndex
DROP INDEX "cost_allocation_rules_sourceAccountCode_key";
-- AlterTable
ALTER TABLE "gift_cards" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "cost_allocation_rules" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "cost_allocation_runs" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "segments" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "storefront_promos" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "promo_codes" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "content_events" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "exception_flags" ADD COLUMN     "tenantId" TEXT;
-- AlterTable
ALTER TABLE "petty_cash_boxes" ADD COLUMN     "tenantId" TEXT;
-- CreateIndex
CREATE INDEX "gift_cards_tenantId_idx" ON "gift_cards"("tenantId");
-- CreateIndex
CREATE UNIQUE INDEX "cost_allocation_rules_tenantId_sourceAccountCode_key" ON "cost_allocation_rules"("tenantId", "sourceAccountCode");
-- CreateIndex
CREATE INDEX "cost_allocation_runs_tenantId_idx" ON "cost_allocation_runs"("tenantId");
-- CreateIndex
CREATE INDEX "segments_tenantId_idx" ON "segments"("tenantId");
-- CreateIndex
CREATE INDEX "campaigns_tenantId_idx" ON "campaigns"("tenantId");
-- CreateIndex
CREATE INDEX "storefront_promos_tenantId_idx" ON "storefront_promos"("tenantId");
-- CreateIndex
CREATE INDEX "promo_codes_tenantId_idx" ON "promo_codes"("tenantId");
-- CreateIndex
CREATE INDEX "content_events_tenantId_startDate_idx" ON "content_events"("tenantId", "startDate");
-- CreateIndex
CREATE INDEX "media_assets_tenantId_createdAt_idx" ON "media_assets"("tenantId", "createdAt");
-- CreateIndex
CREATE INDEX "exception_flags_tenantId_status_createdAt_idx" ON "exception_flags"("tenantId", "status", "createdAt");
-- CreateIndex
CREATE INDEX "petty_cash_boxes_tenantId_idx" ON "petty_cash_boxes"("tenantId");

-- Backfills from the brand (concepts.tenantId) where the row names one.
UPDATE "gift_cards" g SET "tenantId" = c."tenantId" FROM "concepts" c WHERE c.id = g."conceptId" AND g."tenantId" IS NULL;
UPDATE "promo_codes" p SET "tenantId" = c."tenantId" FROM "concepts" c WHERE c.id = p."conceptId" AND p."tenantId" IS NULL;
UPDATE "content_events" e SET "tenantId" = c."tenantId" FROM "concepts" c WHERE c.id = e."conceptId" AND e."tenantId" IS NULL;
UPDATE "exception_flags" f SET "tenantId" = c."tenantId" FROM "concepts" c WHERE c.id = f."conceptId" AND f."tenantId" IS NULL;
UPDATE "petty_cash_boxes" b SET "tenantId" = c."tenantId" FROM "concepts" c WHERE c.id = b."conceptId" AND b."tenantId" IS NULL;
-- A campaign targeting brands of one company belongs to that company.
UPDATE "campaigns" k SET "tenantId" = c."tenantId" FROM "concepts" c
 WHERE k."tenantId" IS NULL AND array_length(k."conceptIds", 1) > 0 AND c.id = k."conceptIds"[1];
-- Media uploaded by a staff member belongs to their company.
UPDATE "media_assets" m SET "tenantId" = u."tenantId" FROM "users" u WHERE u.id = m."uploadedById" AND m."tenantId" IS NULL;
-- Allocation rules and segments name no brand; they belong to the primary company (the first one made).
-- Allocation rules: the company of the brands they weight; rules with no weights go to the primary company.
UPDATE "cost_allocation_rules" k SET "tenantId" = c."tenantId"
  FROM "allocation_rule_weights" w JOIN "concepts" c ON c.id = w."conceptId"
 WHERE w."ruleId" = k.id AND k."tenantId" IS NULL;
UPDATE "cost_allocation_rules" SET "tenantId" = (SELECT id FROM "tenants" WHERE "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1) WHERE "tenantId" IS NULL;
UPDATE "cost_allocation_runs" r SET "tenantId" = k."tenantId" FROM "cost_allocation_rules" k WHERE k.id = r."ruleId" AND r."tenantId" IS NULL;
-- Projections: the company of their brands.
UPDATE "projections" p SET "tenantId" = c."tenantId"
  FROM "projection_brand_inputs" b JOIN "concepts" c ON c.id = b."conceptId"
 WHERE b."projectionId" = p.id AND p."tenantId" IS NULL;
UPDATE "segments" SET "tenantId" = (SELECT id FROM "tenants" WHERE "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1) WHERE "tenantId" IS NULL;
UPDATE "storefront_promos" SET "tenantId" = (SELECT id FROM "tenants" WHERE "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1) WHERE "tenantId" IS NULL;

-- Staff meals belong to the company that served them.
ALTER TABLE "staff_meals" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "staff_meals_tenantId_consumedAt_idx" ON "staff_meals"("tenantId", "consumedAt");
UPDATE "staff_meals" m SET "tenantId" = c."tenantId" FROM "concepts" c WHERE c.id = m."conceptId" AND m."tenantId" IS NULL;
UPDATE "staff_meals" m SET "tenantId" = s."tenantId" FROM "shifts" s WHERE s.id = m."shiftId" AND m."tenantId" IS NULL AND s."tenantId" IS NOT NULL;
UPDATE "staff_meals" m SET "tenantId" = u."tenantId" FROM "users" u WHERE u.id = m."staffId" AND m."tenantId" IS NULL;

-- Older petty-cash boxes with no brand: the custodian's company.
UPDATE "petty_cash_boxes" b SET "tenantId" = u."tenantId" FROM "users" u WHERE u.id = b."custodianId" AND b."tenantId" IS NULL;

-- Older exception flags with no brand: resolve the company through the entity they flag.
UPDATE "exception_flags" f SET "tenantId" = s."tenantId" FROM "shifts" s WHERE f."entityType" = 'Shift' AND s.id = f."entityId" AND f."tenantId" IS NULL;
UPDATE "exception_flags" f SET "tenantId" = c."tenantId" FROM "orders" o JOIN "concepts" c ON c.id = o."conceptId" WHERE f."entityType" = 'Order' AND o.id = f."entityId" AND f."tenantId" IS NULL;
UPDATE "exception_flags" f SET "tenantId" = j."tenantId" FROM "journal_entries" j WHERE f."entityType" = 'JournalEntry' AND j.id = f."entityId" AND f."tenantId" IS NULL;
UPDATE "exception_flags" f SET "tenantId" = b."tenantId" FROM "petty_cash_boxes" b WHERE f."entityType" = 'PettyCashBox' AND b.id = f."entityId" AND f."tenantId" IS NULL;
UPDATE "exception_flags" f SET "tenantId" = p."tenantId" FROM "physical_counts" p WHERE f."entityType" = 'PhysicalCount' AND p.id = f."entityId" AND f."tenantId" IS NULL;
UPDATE "exception_flags" f SET "tenantId" = p."tenantId" FROM "prep_batches" p WHERE f."entityType" = 'PrepBatch' AND p.id = f."entityId" AND f."tenantId" IS NULL;
UPDATE "exception_flags" f SET "tenantId" = i."tenantId" FROM "inventory_items" i WHERE f."entityType" = 'InventoryItem' AND i.id = f."entityId" AND f."tenantId" IS NULL;
UPDATE "exception_flags" f SET "tenantId" = u."tenantId" FROM "users" u WHERE u.id = f."actorId" AND f."tenantId" IS NULL;

-- Rows with no brand at all: the issuer's / creator's company, else the primary company.
UPDATE "gift_cards" g SET "tenantId" = u."tenantId" FROM "users" u WHERE u.id = g."issuedById" AND g."tenantId" IS NULL;
UPDATE "gift_cards" SET "tenantId" = (SELECT id FROM "tenants" WHERE "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1) WHERE "tenantId" IS NULL;
UPDATE "content_events" e SET "tenantId" = u."tenantId" FROM "users" u WHERE u.id = e."createdById" AND e."tenantId" IS NULL;
UPDATE "promo_codes" SET "tenantId" = (SELECT id FROM "tenants" WHERE "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1) WHERE "tenantId" IS NULL;
UPDATE "campaigns" SET "tenantId" = (SELECT id FROM "tenants" WHERE "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1) WHERE "tenantId" IS NULL;
UPDATE "media_assets" SET "tenantId" = (SELECT id FROM "tenants" WHERE "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1) WHERE "tenantId" IS NULL;
