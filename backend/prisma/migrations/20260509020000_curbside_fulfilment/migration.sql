-- Curbside / car-hopping fulfilment fields on Order. Presence of
-- curbsideVehicle is the canonical "this is curbside" signal — no enum
-- change needed, doesn't clash with delivery/pickup/dine-in flags.

ALTER TABLE "orders"
  ADD COLUMN "curbsideVehicle"     TEXT,
  ADD COLUMN "curbsidePlate"       TEXT,
  ADD COLUMN "curbsideSpot"        TEXT,
  ADD COLUMN "curbsideArrivedAt"   TIMESTAMP(3),
  ADD COLUMN "curbsideRunnerOutAt" TIMESTAMP(3);

-- Hot-path queries: active curbside queue ("orders awaiting runner").
CREATE INDEX "orders_curbsideArrivedAt_idx"
  ON "orders" ("curbsideArrivedAt")
  WHERE "curbsideArrivedAt" IS NOT NULL AND "curbsideRunnerOutAt" IS NULL;
