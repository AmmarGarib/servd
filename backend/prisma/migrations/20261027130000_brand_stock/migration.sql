-- Brand stock (owner B13 (a), 2026-10-26): "Each brand keeps its own stock even when it shares a kitchen; moving
-- stock between brands moves the cost between the brands' P&Ls automatically."
-- Columns only (no new table, no data dropped). Contract: header of backend/src/lib/stockLedger.ts ("BRANDS").

ALTER TABLE "stock_lots"        ADD COLUMN "conceptId" TEXT;
ALTER TABLE "goods_receipts"    ADD COLUMN "conceptId" TEXT;
ALTER TABLE "purchase_orders"   ADD COLUMN "conceptId" TEXT;
ALTER TABLE "prep_batches"      ADD COLUMN "conceptId" TEXT;
ALTER TABLE "physical_counts"   ADD COLUMN "conceptId" TEXT;
ALTER TABLE "stock_transfers"   ADD COLUMN "fromConceptId" TEXT;
ALTER TABLE "stock_transfers"   ADD COLUMN "toConceptId" TEXT;
ALTER TABLE "stock_transfers"   ADD COLUMN "brandMove" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "stock_lots_inventoryItemId_locationId_conceptId_idx" ON "stock_lots"("inventoryItemId", "locationId", "conceptId");

-- Backfill: a lot at an outlet with exactly ONE live brand of its company becomes that brand's. Outlets with several
-- brands keep their lots SHARED (conceptId NULL) until a brand count or a brand move assigns them. Safety: when the
-- outlet is (or may become — no stored home yet) the company's STOCK HOME, a brand with no outlet of its own also
-- cooks from it (lib/stockSite.ts stockSiteOf) — then its lots stay shared, so that brand's sales never go short.
WITH live_links AS (
  SELECT cl."locationId", cl."conceptId", c."tenantId"
    FROM concept_locations cl
    JOIN concepts c  ON c.id = cl."conceptId" AND c."deletedAt" IS NULL
    JOIN locations l ON l.id = cl."locationId" AND l."deletedAt" IS NULL AND l."tenantId" = c."tenantId"
),
single AS (
  SELECT "locationId", MIN("conceptId") AS "conceptId", MIN("tenantId") AS "tenantId"
    FROM live_links GROUP BY "locationId" HAVING COUNT(*) = 1
),
homeless AS (
  -- companies with a live brand that has no live outlet of its own (not the "General" holding place)
  SELECT DISTINCT c."tenantId"
    FROM concepts c
   WHERE c."deletedAt" IS NULL AND c."tenantId" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM concept_locations cl JOIN locations l ON l.id = cl."locationId"
        WHERE cl."conceptId" = c.id AND l."deletedAt" IS NULL AND l."tenantId" = c."tenantId"
          AND l.slug <> ('general-' || c."tenantId"))
),
safe AS (
  SELECT s.* FROM single s
   WHERE NOT (
     s."tenantId" IN (SELECT "tenantId" FROM homeless)
     AND COALESCE((SELECT value FROM settings WHERE key = 'stock.homeLocationId:' || s."tenantId"), s."locationId") = s."locationId"
   )
)
UPDATE stock_lots sl SET "conceptId" = safe."conceptId"
  FROM safe
 WHERE sl."locationId" = safe."locationId" AND sl."tenantId" = safe."tenantId" AND sl."conceptId" IS NULL;
