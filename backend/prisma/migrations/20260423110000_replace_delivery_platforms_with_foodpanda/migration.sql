-- Replace UberEats, DoorDash, Deliveroo with Foodpanda in the OrderSource enum.
--
-- PostgreSQL forbids USING a newly-added enum value in the same transaction
-- that adds it (SQLSTATE 55P04), and Prisma wraps each migration in a single
-- transaction. The original version did `ALTER TYPE ... ADD VALUE 'foodpanda'`
-- and then referenced 'foodpanda' in an UPDATE within the same file, so it
-- could not be replayed onto a fresh database (it only succeeded where the
-- value already existed from an out-of-band step).
--
-- Instead we recreate the type — which already contains 'foodpanda' — and remap
-- the retired source values during the column cast. No ADD VALUE, so the whole
-- migration is transaction-safe and replays cleanly from scratch.

ALTER TYPE "OrderSource" RENAME TO "OrderSource_old";

CREATE TYPE "OrderSource" AS ENUM ('servd', 'foodpanda', 'pos', 'cart', 'manual');

ALTER TABLE "orders"
  ALTER COLUMN "source" TYPE "OrderSource"
  USING (
    CASE
      WHEN "source"::text IN ('ubereats', 'doordash', 'deliveroo') THEN 'foodpanda'
      ELSE "source"::text
    END::"OrderSource"
  );

DROP TYPE "OrderSource_old";
