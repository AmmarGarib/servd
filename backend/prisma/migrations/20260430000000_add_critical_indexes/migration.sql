-- Critical performance indexes for production traffic
-- These speed up the hot paths: live order queue, KDS station polling,
-- shift Z-report calculation, and payment lookups by gateway reference.

-- Order: live queue + history filters + shift attribution
CREATE INDEX IF NOT EXISTS "orders_conceptId_placedAt_idx" ON "orders" ("conceptId", "placedAt" DESC);
CREATE INDEX IF NOT EXISTS "orders_status_placedAt_idx"    ON "orders" ("status", "placedAt" DESC);
CREATE INDEX IF NOT EXISTS "orders_customerId_idx"          ON "orders" ("customerId");
CREATE INDEX IF NOT EXISTS "orders_shiftId_idx"             ON "orders" ("shiftId");
CREATE INDEX IF NOT EXISTS "orders_placedAt_idx"            ON "orders" ("placedAt" DESC);

-- OrderItem: KDS pulls "all open items for station X"
CREATE INDEX IF NOT EXISTS "order_items_orderId_idx"            ON "order_items" ("orderId");
CREATE INDEX IF NOT EXISTS "order_items_stationId_status_idx"   ON "order_items" ("stationId", "status");

-- Payment: gateway webhook reconciliation + Z-report
CREATE INDEX IF NOT EXISTS "payments_orderId_idx"           ON "payments" ("orderId");
CREATE INDEX IF NOT EXISTS "payments_shiftId_status_idx"    ON "payments" ("shiftId", "status");
CREATE INDEX IF NOT EXISTS "payments_gatewayRef_idx"        ON "payments" ("gatewayRef");
