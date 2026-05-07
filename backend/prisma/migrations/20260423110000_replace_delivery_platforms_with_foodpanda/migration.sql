-- Replace UberEats, DoorDash, Deliveroo with Foodpanda in OrderSource enum
-- PostgreSQL does not support dropping enum values directly; recreate the type

-- Step 1: Add foodpanda value
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'foodpanda';

-- Step 2: Migrate any existing rows (pre-launch safety net)
UPDATE "orders" SET source = 'foodpanda' WHERE source IN ('ubereats', 'doordash', 'deliveroo');

-- Step 3: Recreate enum without old values
ALTER TYPE "OrderSource" RENAME TO "OrderSource_old";
CREATE TYPE "OrderSource" AS ENUM ('servd', 'foodpanda', 'pos', 'cart', 'manual');

-- Step 4: Migrate the column to new type
ALTER TABLE "orders"
  ALTER COLUMN source TYPE "OrderSource"
  USING source::text::"OrderSource";

-- Step 5: Drop old type
DROP TYPE "OrderSource_old";
