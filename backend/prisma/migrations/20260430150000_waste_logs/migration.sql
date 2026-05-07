-- Add waste_logs table for spoilage / over-prep / damage tracking

CREATE TABLE "waste_logs" (
  "id" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "estimatedCostCents" INTEGER,
  "notes" TEXT,
  "recordedById" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "waste_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "waste_logs_inventoryItemId_fkey"
    FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "waste_logs_recordedById_fkey"
    FOREIGN KEY ("recordedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "waste_logs_inventoryItemId_recordedAt_idx"
  ON "waste_logs" ("inventoryItemId", "recordedAt" DESC);

CREATE INDEX "waste_logs_recordedAt_idx"
  ON "waste_logs" ("recordedAt" DESC);
