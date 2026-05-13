-- Inventory was leaking across tenants: every operator saw every other
-- operator's stock list. Anchor InventoryItem to a tenant + backfill
-- existing rows via the supplier they're sourced from (where one exists).
--
-- Nullable on purpose — legacy rows with no supplier surface as
-- "⚠ No company" so the CEO can claim them.

ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Backfill: pull tenantId from the supplier the item sources from. Items
-- with no supplier (par-sheet-only entries, services, etc.) stay NULL.
UPDATE "inventory_items" ii
SET "tenantId" = s."tenantId"
FROM "suppliers" s
WHERE ii."supplierId" = s.id
  AND ii."tenantId" IS NULL
  AND s."tenantId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "inventory_items_tenantId_idx" ON "inventory_items"("tenantId");

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
