-- Stock transfer workflow between locations. This MVP records the audit
-- trail (requested → approved → shipped → received). Per-location stock
-- mutations are deferred until the deeper InventoryItem-per-location
-- refactor; until then this serves as the authoritative log of movement.

CREATE TABLE "stock_transfers" (
  "id"                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "inventoryItemId"   TEXT NOT NULL REFERENCES "inventory_items"("id"),
  "fromLocationId"    TEXT NOT NULL REFERENCES "locations"("id"),
  "toLocationId"      TEXT NOT NULL REFERENCES "locations"("id"),
  "quantity"          DOUBLE PRECISION NOT NULL,
  "unit"              TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'requested',
  "reason"            TEXT,
  "notes"             TEXT,
  "requestedById"     TEXT NOT NULL,
  "approvedById"      TEXT,
  "shippedById"       TEXT,
  "receivedById"      TEXT,
  "cancelledById"     TEXT,
  "requestedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt"        TIMESTAMP(3),
  "shippedAt"         TIMESTAMP(3),
  "receivedAt"        TIMESTAMP(3),
  "cancelledAt"       TIMESTAMP(3),
  "cancelReason"      TEXT,
  "receivedQuantity"  DOUBLE PRECISION
);

CREATE INDEX "stock_transfers_status_requestedAt_idx"
  ON "stock_transfers" ("status", "requestedAt");

CREATE INDEX "stock_transfers_inventoryItemId_idx"
  ON "stock_transfers" ("inventoryItemId");

CREATE INDEX "stock_transfers_fromLocationId_status_idx"
  ON "stock_transfers" ("fromLocationId", "status");

CREATE INDEX "stock_transfers_toLocationId_status_idx"
  ON "stock_transfers" ("toLocationId", "status");
