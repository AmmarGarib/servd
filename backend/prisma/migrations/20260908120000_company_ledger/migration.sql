-- Per-company ledger: chart of accounts, journal entries and period locks.
--
-- Until now there was ONE chart of accounts, one journal and one period-lock
-- list shared by every company. So GSX Viva's sales posted into the same 4001
-- as GS Foods', a P&L mixed both companies' books, and closing one company's
-- month froze the other's postings. Each company now owns its own set:
--   • accounts.code is unique PER COMPANY (was globally unique)
--   • journal_entries carry the company they belong to
--   • period_locks are per company
--
-- Existing rows belong to the primary (oldest active) company. Every OTHER
-- company gets its own copy of the chart of accounts, so their postings have
-- somewhere to land from the moment this migration runs.

ALTER TABLE "accounts"        ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "period_locks"    ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Journal entries: the company of any brand attributed on their lines.
UPDATE "journal_entries" je
SET "tenantId" = sub."tenantId"
FROM (
  SELECT DISTINCT ON (jl."journalEntryId") jl."journalEntryId", c."tenantId"
  FROM "journal_lines" jl
  JOIN "concepts" c ON c.id = jl."conceptId"
  WHERE c."tenantId" IS NOT NULL
  ORDER BY jl."journalEntryId", jl.id
) sub
WHERE je.id = sub."journalEntryId" AND je."tenantId" IS NULL;

DO $$
DECLARE
  primary_tenant TEXT;
  t RECORD;
BEGIN
  SELECT id INTO primary_tenant FROM "tenants"
   WHERE "isActive" = true AND "deletedAt" IS NULL
   ORDER BY "createdAt" ASC LIMIT 1;

  IF primary_tenant IS NOT NULL THEN
    UPDATE "accounts"        SET "tenantId" = primary_tenant WHERE "tenantId" IS NULL;
    UPDATE "period_locks"    SET "tenantId" = primary_tenant WHERE "tenantId" IS NULL;
    UPDATE "journal_entries" SET "tenantId" = primary_tenant WHERE "tenantId" IS NULL;
  END IF;

  -- Unique per company instead of globally, so each company can run the same
  -- standard codes (1010 cash, 4001 revenue, …) on its own books.
  DROP INDEX IF EXISTS "accounts_code_key";
  CREATE UNIQUE INDEX IF NOT EXISTS "accounts_tenantId_code_key" ON "accounts" ("tenantId", "code");

  -- Give every other company its own copy of the primary chart, so their
  -- first order doesn't fail with "chart of accounts is missing code 4001".
  IF primary_tenant IS NOT NULL THEN
    FOR t IN
      SELECT id FROM "tenants"
       WHERE "isActive" = true AND "deletedAt" IS NULL AND id <> primary_tenant
    LOOP
      INSERT INTO "accounts" ("id", "tenantId", "code", "name", "type", "description", "isActive", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, t.id, a."code", a."name", a."type", a."description", a."isActive", now(), now()
      FROM "accounts" a
      WHERE a."tenantId" = primary_tenant
        -- Dead aggregator accounts (Foodpanda receivable / commission) are not
        -- carried into a new company's chart; servd runs its own fleet.
        AND a."code" NOT IN ('1120', '2070', '6090')
      ON CONFLICT ("tenantId", "code") DO NOTHING;
    END LOOP;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "accounts_tenantId_idx"     ON "accounts" ("tenantId");
CREATE INDEX IF NOT EXISTS "period_locks_tenantId_idx" ON "period_locks" ("tenantId");
CREATE INDEX IF NOT EXISTS "journal_entries_tenantId_entryDate_idx" ON "journal_entries" ("tenantId", "entryDate");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_tenantId_fkey') THEN
    ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'period_locks_tenantId_fkey') THEN
    ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_tenantId_fkey') THEN
    ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
