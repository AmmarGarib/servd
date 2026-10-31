-- Current / non-current on asset and liability accounts (owner, 2026-10-31). NULL = the default by code
-- (lib/accountTerm.ts), so no backfill: existing accounts read their default until finance picks one.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "classification" TEXT;
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_classification_chk";
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_classification_chk" CHECK (
  "classification" IS NULL
  OR ("classification" IN ('current', 'non_current') AND "type" IN ('asset', 'liability'))
);
