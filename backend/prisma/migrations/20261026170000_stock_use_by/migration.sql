-- Use-by dates on perishable deliveries (owner B6, 2026-10-26). Columns only, nothing dropped.
ALTER TABLE "ingredient_masters" ADD COLUMN "perishable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ingredient_masters" ADD COLUMN "shelfLifeDays" INTEGER;
ALTER TABLE "ingredient_masters" ADD CONSTRAINT "ingredient_masters_shelf_life_chk" CHECK ("shelfLifeDays" IS NULL OR ("shelfLifeDays" >= 1 AND "shelfLifeDays" <= 3650));

ALTER TABLE "inventory_items" ADD COLUMN "perishable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "inventory_items" ADD COLUMN "shelfLifeDays" INTEGER;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_shelf_life_chk" CHECK ("shelfLifeDays" IS NULL OR ("shelfLifeDays" >= 1 AND "shelfLifeDays" <= 3650));

ALTER TABLE "stock_lots" ADD COLUMN "useBy" DATE;
ALTER TABLE "stock_lots" ADD COLUMN "useByWarnedAt" TIMESTAMP(3);
ALTER TABLE "stock_lots" ADD COLUMN "expiredWarnedAt" TIMESTAMP(3);
CREATE INDEX "stock_lots_use_by_open" ON "stock_lots" ("tenantId", "useBy") WHERE "useBy" IS NOT NULL AND "remainingQty" > 0;
