-- Test company (owner, 2026-10-14): a CEO-only flag on a company. A test company has fiscal reporting off, is left out
-- of "All companies" totals, never messages customers or outside parties, and its brands are never advertised.
-- Its own books keep working. The one predicate is backend/src/lib/testCompany.ts.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT false;
