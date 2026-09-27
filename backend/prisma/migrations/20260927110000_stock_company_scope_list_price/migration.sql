-- Counts and prep batches belong to a company; backfilled from the items they touch.
ALTER TABLE "physical_counts" ADD COLUMN "tenantId" TEXT;
UPDATE "physical_counts" pc SET "tenantId" = s.t
  FROM (SELECT l."countId", MIN(i."tenantId") AS t
          FROM "physical_count_lines" l JOIN "inventory_items" i ON i.id = l."inventoryItemId"
         WHERE i."tenantId" IS NOT NULL GROUP BY l."countId") s
 WHERE s."countId" = pc.id;
CREATE INDEX "physical_counts_tenantId_countedAt_idx" ON "physical_counts"("tenantId", "countedAt");

ALTER TABLE "prep_batches" ADD COLUMN "tenantId" TEXT;
UPDATE "prep_batches" pb SET "tenantId" = (
  SELECT i."tenantId" FROM jsonb_array_elements(pb.inputs) e
    JOIN "inventory_items" i ON i.id = e->>'inventoryItemId'
   WHERE i."tenantId" IS NOT NULL LIMIT 1);
CREATE INDEX "prep_batches_tenantId_createdAt_idx" ON "prep_batches"("tenantId", "createdAt");

-- The negotiated sourcing price, kept as a reference; cost is the delivery average.
ALTER TABLE "inventory_items" ADD COLUMN "listPriceCents" INTEGER;
UPDATE "inventory_items" SET "listPriceCents" = "unitCostCents";
