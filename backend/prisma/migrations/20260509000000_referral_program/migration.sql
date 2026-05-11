-- Referral program. Each customer gets a unique 8-char code; new signups
-- can attribute themselves to a referrer; both parties earn a loyalty
-- bonus when the referee's first order completes.
--
-- Idempotent — uses IF NOT EXISTS guards because a previous attempt may
-- have applied the ALTERs before failing on a Postgres function call.

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "referralCode"             TEXT,
  ADD COLUMN IF NOT EXISTS "referredById"             TEXT,
  ADD COLUMN IF NOT EXISTS "referredAt"               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "referralRewardCreditedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "customers_referralCode_key"
  ON "customers" ("referralCode");

CREATE INDEX IF NOT EXISTS "customers_referredById_idx"
  ON "customers" ("referredById");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'customers_referredById_fkey'
       AND table_name = 'customers'
  ) THEN
    ALTER TABLE "customers"
      ADD CONSTRAINT "customers_referredById_fkey"
      FOREIGN KEY ("referredById") REFERENCES "customers"("id") ON DELETE SET NULL;
  END IF;
END$$;

-- Backfill: give every existing customer a referral code so they can share
-- right away. 8 hex chars from md5(random) — 16^8 = 4 billion, collision-safe.
UPDATE "customers"
   SET "referralCode" = upper(substring(md5(random()::text || id) from 1 for 8))
 WHERE "referralCode" IS NULL;
