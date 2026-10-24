-- Stock by site, prep as stock (owner, 2026-10-24: "Each fired dish deducts its recipe from stock, with units,
-- yields and prep items; weekly variance of recipe against actual usage"). Binding decisions: FIFO lots stay (D1),
-- the trigger stays at ring-up (D2), prep items become stock (D3), per-site stock now (D4).
--
-- Additive only. Every lot keeps its row; lots with no site are moved to the company's STOCK HOME by the app's
-- one-time site cut-over (lib/stockSite.ts ensureSiteCutover, marker Setting 'stock.siteCutoverAt:<tenantId>'), which
-- also rebuilds stock_balances — the backfill below seeds the balances of lots that already name a site.

-- Inventory items: prep items (one per prep recipe), purchase units, the count schedule.
ALTER TABLE "inventory_items" ADD COLUMN "countFrequency" TEXT NOT NULL DEFAULT 'weekly',
ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'stock',
ADD COLUMN "prepRecipeId" TEXT,
ADD COLUMN "purchaseUnit" TEXT,
ADD COLUMN "purchaseUnitFactor" DOUBLE PRECISION NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "inventory_items_prepRecipeId_key" ON "inventory_items"("prepRecipeId");
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_prepRecipeId_fkey" FOREIGN KEY ("prepRecipeId") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A prep recipe's yield unit (g / ml / pcs) — the unit of its prep stock item.
ALTER TABLE "recipes" ADD COLUMN "yieldUnit" TEXT NOT NULL DEFAULT 'g';

-- The recipe gate: dishes live at go-live without an approved (production) plate recipe stay switchable.
ALTER TABLE "menu_items" ADD COLUMN "liveAtRecipeGate" BOOLEAN NOT NULL DEFAULT false;
UPDATE "menu_items" m SET "liveAtRecipeGate" = true
 WHERE m."isAvailable" = true AND m."deletedAt" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "recipes" r WHERE r."menuItemId" = m.id AND r."kind" = 'plate' AND r."status" = 'production');

-- The per-site on-hand cache (kept by lib/stockLedger.ts).
CREATE TABLE "stock_balances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stock_balances_tenantId_idx" ON "stock_balances"("tenantId");
CREATE INDEX "stock_balances_tenantId_locationId_idx" ON "stock_balances"("tenantId", "locationId");
CREATE UNIQUE INDEX "stock_balances_inventoryItemId_locationId_key" ON "stock_balances"("inventoryItemId", "locationId");
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "stock_lots_inventoryItemId_locationId_idx" ON "stock_lots"("inventoryItemId", "locationId");
CREATE INDEX "stock_movements_tenantId_locationId_occurredAt_idx" ON "stock_movements"("tenantId", "locationId", "occurredAt");

-- Seed the balances of lots that already name a site (the rest follow the site cut-over).
INSERT INTO "stock_balances" ("id", "tenantId", "inventoryItemId", "locationId", "qty", "updatedAt")
SELECT md5(l."inventoryItemId" || ':' || l."locationId"), l."tenantId", l."inventoryItemId", l."locationId", SUM(l."remainingQty"), now()
  FROM "stock_lots" l
 WHERE l."locationId" IS NOT NULL
 GROUP BY l."tenantId", l."inventoryItemId", l."locationId"
ON CONFLICT ("inventoryItemId", "locationId") DO NOTHING;

-- The lot-source and movement-kind CHECKs learn transfers and prep lots (re-made below).
ALTER TABLE "stock_lots" DROP CONSTRAINT IF EXISTS "stock_lots_source_chk";
ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_kind_chk";

-- ─── SQL-only objects (tests/setup.ts applies this section after dropping the two CHECKs itself; no ';' inside a statement)
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_source_chk" CHECK ("sourceType" IN ('goods_receipt_line', 'count_gain', 'opening', 'fifo_cutover', 'legacy_return', 'transfer_in', 'prep_batch'));
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_chk" CHECK ("kind" IN ('receipt', 'opening', 'fifo_cutover', 'count_gain', 'count_loss', 'sale', 'sale_return', 'sale_void', 'waste', 'prep_draw', 'supplier_return', 'cost_adjust', 'class_reclass', 'legacy_return', 'issue_on_receipt', 'shortfall_settle', 'transfer_out', 'transfer_in', 'prep_make'));
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_kind_chk" CHECK ("kind" IN ('stock', 'prep') AND ("prepRecipeId" IS NULL OR "kind" = 'prep'));
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_count_frequency_chk" CHECK ("countFrequency" IN ('daily', 'weekly'));
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_purchase_unit_factor_chk" CHECK ("purchaseUnitFactor" > 0);
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_yield_unit_chk" CHECK ("yieldUnit" IN ('g', 'ml', 'pcs'));

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261024120000_city_ledger)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['stock_balances']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY %I ON %I FOR ALL '
          'USING (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids())) '
          'WITH CHECK (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids()))',
          t || '_rls', t, t, t);
      END IF;
    END LOOP;
  END IF;
END
$do$;
