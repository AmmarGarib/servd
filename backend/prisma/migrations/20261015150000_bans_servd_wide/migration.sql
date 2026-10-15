-- Customer strikes and bans are SERVD-WIDE (owner, 2026-10-15: "let it be across servd. No need to do it per
-- company"). A customer's strikes count across every company, and one active AUTO ban per customer blocks them
-- everywhere; each strike and ban still records the company where it was raised (tenantId), and only that company
-- (or the CEO through it) decides it.
--
-- 1) Older rows could hold one active auto ban per company for the same customer. Keep the OLDEST active auto ban
--    per customer and lift the others (the customer stays blocked; a lifted row stays as history).
UPDATE "customer_bans" b
SET "liftedAt" = NOW(), "liftReason" = 'servd-wide bans (2026-10-15): duplicate auto ban of the same customer'
WHERE b."liftedAt" IS NULL AND b."bannedById" IS NULL AND b."customerId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "customer_bans" o
    WHERE o."customerId" = b."customerId" AND o."liftedAt" IS NULL AND o."bannedById" IS NULL
      AND (o."bannedAt" < b."bannedAt" OR (o."bannedAt" = b."bannedAt" AND o."id" < b."id"))
  );

-- Never queue behind a long lock on live: fail fast and retry the deploy instead.
SET lock_timeout = '10s';

-- 2) Replace the per-company index with one per customer.
DROP INDEX IF EXISTS "customer_bans_one_active_auto_per_company";

-- ─── SQL-only objects (tests/setup.ts reads from here to the end: no ';' inside a statement, no trailing comments)
CREATE UNIQUE INDEX "customer_bans_one_active_auto_per_customer" ON "customer_bans" ("customerId")
  WHERE "liftedAt" IS NULL AND "bannedById" IS NULL AND "customerId" IS NOT NULL;
