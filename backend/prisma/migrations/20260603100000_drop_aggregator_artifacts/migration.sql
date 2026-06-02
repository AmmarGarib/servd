-- Removes every artifact of third-party-delivery aggregator support.
--
-- The codebase shipped with Foodpanda and Careem adapters from day one, but
-- the operator made an early decision to run their own fleet instead. The
-- adapter directories were deleted long ago; this migration cleans up the
-- DB schema that still carried hooks for them:
--
--   * OrderSource enum loses 'foodpanda' and 'careem' (any historical orders
--     still on those sources are remapped to 'servd' first — keeps the rows,
--     loses the source attribution).
--   * concepts.foodpandaCommissionRate column is dropped.
--   * foodpanda_settlements table is dropped (was unused by any application
--     code path — safe to remove unconditionally).

-- Re-map historical orders so the enum drop doesn't error on existing data.
UPDATE "orders" SET "source" = 'servd'::"OrderSource" WHERE "source" IN ('foodpanda', 'careem');

-- Postgres can't DROP VALUE on an enum in use — rename the old type, create
-- a fresh one without the legacy values, swap the column type, drop the old.
ALTER TYPE "OrderSource" RENAME TO "OrderSource_old";
CREATE TYPE "OrderSource" AS ENUM ('servd', 'pos', 'cart', 'manual');
ALTER TABLE "orders"
  ALTER COLUMN "source" TYPE "OrderSource"
  USING ("source"::text::"OrderSource");
DROP TYPE "OrderSource_old";

-- Drop the per-concept negotiated commission rate column.
ALTER TABLE "concepts" DROP COLUMN IF EXISTS "foodpandaCommissionRate";

-- Drop the settlement-reconciliation table (model + no callers).
DROP TABLE IF EXISTS "foodpanda_settlements";
